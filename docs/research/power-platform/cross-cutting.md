# Cross-cutting: identity, licensing, limits, telemetry, maker UX, Teams and Microsoft 365

Research date: 18 November 2026. Sources are Microsoft Learn pages retrieved on that date, plus community forum threads (marked anecdotal). Opinions are labelled *inference*; unconfirmed claims are labelled *unverified*.

## 1. Identity: Microsoft Entra ID

Every Power Platform user is a Microsoft Entra ID (formerly Azure AD) identity in the customer's tenant.

- **Tenant access** is the first layer: an active Entra account, conditional access policies, and a licence. A licence and identity alone don't grant environment access (except the default environment); a security role does ([identity and access management](https://learn.microsoft.com/power-platform/guidance/adoption/conditional-access#tenant-access)).
- Recommended controls: least-privilege admin roles, **Privileged Identity Management** for just-in-time elevation, MFA/passwordless, conditional access, decommissioning unused admin accounts. Tenant admins are no longer auto-assigned System Administrator inside environments ([identity guidance](https://learn.microsoft.com/power-platform/guidance/adoption/conditional-access#tenant-access), [control user access](https://learn.microsoft.com/power-platform/admin/control-user-access#review-admin-roles-you-need-to-complete-different-tasks)).
- User lifecycle is split: User Administrator creates users, License Administrator assigns licences, Groups Administrator manages security groups, Power Platform/Dynamics 365 admins attach groups to environments, System Administrators assign Dataverse roles.
- **Guests** (Entra B2B) can use canvas apps if licensed; guest access to Dataverse environments is restricted by default for new environments ([guest access](https://learn.microsoft.com/power-platform/guidance/adoption/conditional-access#environment-access), [share with guests FAQ](https://learn.microsoft.com/power-apps/maker/canvas-apps/share-app-guests#frequently-asked-questions)). Canvas apps don't support Entra "External member" identities ([connectors for canvas apps](https://learn.microsoft.com/power-apps/maker/canvas-apps/connections-list#security-and-types-of-authentication)).
- External (customer) identities go through Power Pages and Entra External ID, a separate CIAM service (see `power-pages.md`).
- **Application users** (service principals) can run in environments secured by security groups without group membership ([control user access](https://learn.microsoft.com/power-platform/admin/control-user-access)).

## 2. Licensing at a concept level

From the [licensing overview](https://learn.microsoft.com/power-platform/admin/pricing-billing-skus#understand-license-and-billing-options), [licensing FAQ](https://learn.microsoft.com/power-platform/admin/powerapps-flow-licensing-faq#power-apps) and [pay-as-you-go](https://learn.microsoft.com/power-platform/admin/pay-as-you-go-overview):

| Model | Concept | Notes (from fetched pages) |
|---|---|---|
| Seeded (Microsoft 365, Dynamics 365) | Limited Power Apps/Power Automate rights inside Microsoft 365 | Standard connectors only; no standalone custom apps on Dataverse, premium flows or Copilot Studio agents. A "Dataverse" service plan visible in M365 admin doesn't grant full rights. |
| Per user (Power Apps Premium) | Unlimited apps and sites for one user | FAQ lists $20/user/month ($12 at 2,000+ new licences) |
| Per app | One app (or one Power Pages site) per user per environment, stackable | FAQ lists $5/user/app/month; **end of sale to new customers through some channels from 2 January 2026** |
| Pay-as-you-go | Environment linked to an **Azure subscription** via a billing policy; billed per unique monthly active user per app, plus Dataverse and request overage; Power Automate premium runs per run ($0.60 cloud/attended, $3.00 unattended per the [meters page](https://learn.microsoft.com/power-platform/admin/pay-as-you-go-meters#how-do-meters-work)) | Production and sandbox environments only; all apps in the environment billed; per-app passes ignored ([PAYG FAQ](https://learn.microsoft.com/power-platform/admin/pay-as-you-go-issues-faq#frequently-asked-questions)) |
| Power Automate | Premium per user, Process per flow (250k requests/day), seeded in-context rights | See `power-automate.md` |
| Capacity add-ons | Dataverse database/file/log, AI Builder credits, Power Pages capacity, Copilot Credits | |
| Power Pages | Authenticated / anonymous users per site per month | See `power-pages.md` |
| Copilot Studio | Copilot Credits (packs or PAYG) | See `copilot-studio.md` |

**Premium boundary**: since the October 2019 change, SQL Server, Azure SQL, Dynamics 365, Business Central, and ~30 Azure connectors are premium; a standalone licence is required for all premium, on-premises and custom connectors ([licensing FAQ, PAYG section](https://learn.microsoft.com/power-platform/admin/powerapps-flow-licensing-faq#power-platform-pay-as-you-go-plan)). A canvas app that uses one premium connector makes every user of that app need a premium licence (see the pay-as-you-go meter table: Microsoft 365-licensed users are charged for apps with premium connectors). In-context rules for flows add nuance: a premium flow associated with and triggered by a Power App can be run by users of that app ([seeded licenses](https://learn.microsoft.com/power-platform/admin/power-automate-licensing/deep-dive-on-specific-license#power-automate-seeded-licenses)). Auto-claim policies can assign per-user licences automatically when someone opens a premium app or uses a managed environment ([environment strategy](https://learn.microsoft.com/power-platform/guidance/adoption/environment-strategy#features-that-support-an-enterprise-scale,-environment-strategy)).

Anecdotal (community forums, titles only): threads such as ["Licensing madness - scaling"](https://powerusers.microsoft.com/t5/Building-Power-Apps/Licensing-madness-scaling/m-p/418262) and ["Help understanding powerapps license changes October 2019"](https://powerusers.microsoft.com/t5/General-Discussion/Help-understanding-powerapps-license-changes-October-2019/m-p/355562) and ["SQL premium connector alternative"](https://jgvjg48436.lithium.com/t5/Building-Power-Apps/SQL-premium-connector-alternative/m-p/688016) show the recurring themes: confusion after licence changes and searching for ways to avoid premium connectors.

## 3. "Power Platform request limits"

Two different limit families ([Dataverse API limits overview](https://learn.microsoft.com/power-apps/maker/data-platform/api-limits-overview)):

| | Service protection limits | Power Platform requests (entitlements) |
|---|---|---|
| Purpose | Protect the shared service from bursts | Allocate paid capacity |
| Window | 5-minute sliding | 24 hours |
| Enforcement | Immediate HTTP 429 with `Retry-After` | Throttling/slowdown of flows; reports for admins |
| Scope | Per user, **per web server** (an environment has several; trial has one) | Per user licence or per flow (Process) |
| Default values | 6,000 requests, 1,200 s combined execution time, 52+ concurrent requests per user per web server ([service protection](https://learn.microsoft.com/power-apps/developer/data-platform/api-limits#how-dataverse-enforces-service-protection-api-limits)) | Premium user 40,000 / 24 h; Process flow 250,000 / 24 h; add-on packs +50,000 per user ([requests limits](https://learn.microsoft.com/power-platform/admin/api-request-limits-allocations#request-limits-in-power-automate)) |
| Not applied to | Calls inside plug-ins and workflows | Desktop flow runs |

Microsoft says the `Retry-After` grows if a client keeps sending demanding requests, and recommends ramping up gradually and letting the server signal capacity ([retry operations](https://learn.microsoft.com/power-apps/developer/data-platform/api-limits#retry-operations)). Dataverse search has its own lower limits: 1 request/second per user, 150/minute per organisation ([Dataverse search](https://learn.microsoft.com/power-apps/developer/data-platform/search/overview#service-protection-limits-for-dataverse-search)).

*Inference*: for a single-tenant on-prem server, the only meaningful limit is "don't let one user or one runaway flow starve everyone else". Entitlement metering is a business model, not a technical need.

## 4. Telemetry

- **Application Insights** integration for canvas apps (instrumentation key in the app), Dataverse and model-driven apps (export, a managed-environments feature), cloud flows, and Copilot Studio agents ([monitoring strategy](https://learn.microsoft.com/power-platform/well-architected/reliability/monitoring-alerting-strategy#power-platform-facilitation), [managed environments](https://learn.microsoft.com/power-platform/admin/managed-environment-overview)).
- **PPAC Monitor** for operational health; **analytics** reports for usage; **Purview** activity logs for audit (~24 h delay); **Live monitor** for makers (see `admin-and-environments.md` and `power-apps.md`).
- Microsoft's own observability guidance lists 5+ tools for admins to combine ([adoption observability](https://learn.microsoft.com/power-platform/guidance/adoption/observability#tools)).

## 5. Maker portal UX patterns

From [Get started with Power Apps](https://learn.microsoft.com/power-apps/maker/canvas-apps/intro-maker-portal#1-%E2%80%93-left-navigation-pane) and related pages:

| Pattern | What it looks like in make.powerapps.com |
|---|---|
| Environment picker in the header | Every page is scoped to one environment; switching is global |
| Left nav with pinning | Home, Create, Learn, Plans, Apps, AI hub, plus the three most used pages (Tables, Connections, Flows...) auto-pinned; "More" for the rest |
| Start-with-data creation | "Start with data" from SharePoint, Excel, Dataverse, or describe-in-plain-language with Copilot; generates a three-screen browse/detail/edit canvas app ([app from SharePoint](https://learn.microsoft.com/power-apps/maker/canvas-apps/app-from-sharepoint#create-a-list)) |
| Solutions as the "real" workspace | Many guides start "select Solutions, open an unmanaged solution" — the solution explorer is where serious work happens ([create model-driven app](https://learn.microsoft.com/power-apps/maker/model-driven-apps/create-model-driven-app#create-an-app)) |
| Table designer | Tables list → table hub (columns, relationships, keys, views, forms, business rules, dashboards, charts) |
| Command bar + side panes | Contextual commands on top; create/edit in right-side panels |
| Copilot everywhere | Describe an app, a table, a flow; column suggestions on forms ([form designer Copilot](https://learn.microsoft.com/power-apps/maker/model-driven-apps/create-and-edit-forms#edit-a-form)); a new "AI-native" Power Apps experience in preview ([intro](https://learn.microsoft.com/power-apps/maker/canvas-apps/intro-maker-portal)) |
| Separate portals per product | make.powerapps.com, make.powerautomate.com, make.powerpages.microsoft.com, copilotstudio.microsoft.com, admin.powerplatform.microsoft.com, app.powerbi.com |

## 6. Teams integration

- **Embed apps in Teams** as a personal app or a channel tab, from the maker portal ("Add to Teams") or the web player; requires tenant policies allowing custom and shared Power Apps; Teams context is available through `Param()` (theme, teamId, channelId, locale, userTeamRole...) ([embed as personal app](https://learn.microsoft.com/power-apps/teams/embed-teams-app), [embed as tab](https://learn.microsoft.com/power-apps/teams/embed-teams-tab#add-an-app)). Known issues in Teams: HTTPS-only content, limited sensors, mobile users can't download attachments; offline canvas doesn't work in Teams; new-version notifications don't appear in Teams ([save and publish](https://learn.microsoft.com/power-apps/maker/canvas-apps/save-publish-app#in-app-notifications-for-new-versions)).
- **Dataverse for Teams** (a free, Teams-bound Dataverse with 2 GB per team, ~1 million rows, no API access, no custom connectors) is **deprecated**: no new environments from 15 November 2026, suspension of non-upgraded environments on 15 September 2027, decommission on 30 October 2027; upgrading requires Dataverse capacity and premium licences for users ([deprecation](https://learn.microsoft.com/power-platform/important-changes-coming#deprecation-of-microsoft-dataverse-for-teams-environments), [comparison](https://learn.microsoft.com/power-apps/teams/data-platform-compare)).
- **Approvals in Teams**: the Approvals app and adaptive cards; data in Dataverse, template responses in Microsoft Forms (see `power-automate.md`).
- **Agents in Teams**: Copilot Studio agents publish to Teams and Microsoft 365 Copilot; group chats can't use user-authenticated knowledge (see `copilot-studio.md`).

## 7. Microsoft 365 integration points relevant to a small org

| Integration | How it works | Caveats (from fetched pages) |
|---|---|---|
| SharePoint lists as data | Standard connector; "Start with data" builds an app; app writes back to the list ([app from SharePoint](https://learn.microsoft.com/power-apps/maker/canvas-apps/app-from-sharepoint#create-a-list)) | Delegation quirks (`IsBlank` vs `= Blank()`, lookups), 500/10,000-row ceilings for non-delegable formulas ([SharePoint delegation](https://learn.microsoft.com/power-apps/maker/canvas-apps/connections/connection-sharepoint-online#power-apps-delegable-functions-and-operations-for-sharepoint)); weak ALM support for SharePoint data sources across environments ([env var troubleshooting](https://learn.microsoft.com/troubleshoot/power-platform/dataverse/working-with-solutions/dataverse-environment-variables#symptoms)) |
| Custom SharePoint list forms | Replace a list's form with a canvas app; Power Apps web part on pages; InfoPath migration path ([SharePoint customizing](https://learn.microsoft.com/sharepoint/extend-and-develop#forms)) | Guests need licences if the form uses premium connectors |
| SharePoint/OneDrive document libraries | Files via connectors; knowledge for agents via Graph search | Agent file-size limits without M365 Copilot (see `copilot-studio.md`) |
| Excel files | Excel Online (Business) connector over tables in workbooks | Non-delegable; row limit applies; Microsoft suggests partitioning data ([performance](https://learn.microsoft.com/power-apps/maker/canvas-apps/app-performance-considerations#specific-data-sources)) |
| Outlook | Send email, actionable approval messages | Up to 5 custom response buttons |
| Planner, To Do, Loop, OneNote | Connectors exist for Planner and To Do; Loop components can embed some Power Platform content | *Unverified* — not researched on fetched pages beyond the connector catalogue's existence |
| Power BI | Embedding in apps (see `power-bi-lite.md`) | |

## How to replicate on our stack (single Node server + MySQL)

### Identity

- Keep **local accounts** (scrypt, HttpOnly session cookie — exists) as the default. Add, in order: **TOTP MFA** for admins and makers; **email/WhatsApp OTP** sign-in for shop-floor users who share devices; **OIDC SSO** with Google Workspace and Microsoft Entra ID (authorization code + PKCE; map `email` → `ab_users`, optional group claim → role mapping) for customers who already have one.
- One "People" screen: create user, assign roles, environments and teams, reset password, disable — the five Microsoft steps collapse into one (see `admin-and-environments.md`).
- Device/shift accounts: an option for a shared kiosk login that requires a 4-digit PIN per operator for writes (audit attributes the PIN holder) — a real need on factory floors that Microsoft's per-user identity model doesn't address (*inference*).
- Service accounts (`ab_users.kind = 'service'`) for flows and integrations, with API tokens (`ab_api_tokens(hash, user_id, scopes, expires_on, last_used)`).

### Licensing (our business model, technical implications)

- Licence per install (or per environment), not per user or per app. The server stores a signed licence file (`workspace/licence.json`, Ed25519 signature checked at boot) with `{ customer, maxUsers?, modules: ['apps','flows','sites','agents','chat','docs'], expires }`. No phone-home required (on-prem, poor internet), optional online renewal.
- No premium/standard connector split. Modules can be priced; connectors are not.

### Limits

- Protective rate limits only: per-user token bucket on the API router (e.g. 50 req/s burst, 10 req/s sustained), per-flow concurrency, per-agent LLM budgets. Return 429 with `Retry-After`; the client retries reads automatically. All thresholds editable by the admin.
- No daily entitlement counters.

### Telemetry

- **Local first**: structured JSON logs (pino-style) to `workspace/logs/` with rotation; a `/admin/health` page (see `admin-and-environments.md`); per-app usage counts (opens per day, active users) from session data; Monitor for makers (see `power-apps.md`).
- Optional **OpenTelemetry** export (OTLP over HTTP) for partners who run Grafana/Loki; off by default.
- Product telemetry to us: **opt-in**, anonymous, version + feature counters only. On-prem buyers will ask.

### Maker portal UX (what to copy, what to change)

- Copy: environment switcher in the header, left nav with Home / Apps / Tables / Flows / Sites / Agents / Dashboards / Documents / Solutions / Connections, "Start from data" (CSV/Excel/Google Sheet → table → auto app, which we half-have), right-side panels for create/edit, a command bar per page, global search (Ctrl+K — `cmdk` is already a dependency).
- Change: **one portal** for everything (apps, flows, sites, agents, admin) — not six sites; no "go to Solutions to do it properly": every object page shows "In solution: X" with an add button; templates for the pilot sector (QC inspection, maintenance, production log) on Home.
- AI assist where it removes typing: "Describe a table" → columns; "Describe a flow" → draft steps; formula explanation in the formula bar. Behind the same provider settings and budgets as agents.

### Team chat as our "Teams integration"

Since we're building an embedded team chat, design the integration points Microsoft has between Teams and Power Platform *natively*:

| Microsoft | Ours |
|---|---|
| App as Teams tab/personal app | Pin any app or dashboard to a chat channel as a tab |
| Adaptive cards for approvals | Approval cards in chat posted by the flow engine, respond inline |
| Bots/agents in Teams | Agents as chat members (@QC-Helper) |
| Teams context in `Param()` | `Chat.Channel`, `Chat.Thread` available to apps opened from chat |
| Notifications | Flow step "Post to channel", mentions, read receipts |
| Record links | Pasting an app record URL unfurls a card with key fields (security-checked) |

### Microsoft 365 / Google Workspace connectors for small orgs

Ship as action/table connectors (see `connectors.md`), not as platform dependencies: Microsoft Graph (Outlook mail and calendar, OneDrive/SharePoint files, Excel tables, Planner tasks, Teams channel message), Google (Gmail, Calendar, Drive, Sheets — Sheets exists). Most Indian 20-50 person manufacturers use Google Workspace or plain email + WhatsApp more than Microsoft 365 (*inference; check during pilot*), so neither should be assumed.

## Where we can be better for a 20-50 person org

| Microsoft pain point | Evidence | Better design |
|---|---|---|
| Licensing spans seeded, per user, per app (now end-of-sale in some channels), PAYG via Azure, Process per flow, capacity add-ons, Power Pages capacity, Copilot Credits | [Licensing overview](https://learn.microsoft.com/power-platform/admin/pricing-billing-skus#understand-license-and-billing-options), [licensing FAQ](https://learn.microsoft.com/power-platform/admin/powerapps-flow-licensing-faq#power-apps) | One licence per install with modules |
| Premium connector paywall makes the whole app premium for every user | [Premium connector list](https://learn.microsoft.com/power-platform/admin/powerapps-flow-licensing-faq#power-platform-pay-as-you-go-plan), [PAYG meters](https://learn.microsoft.com/power-platform/admin/pay-as-you-go-meters#how-do-meters-work); anecdotal: [forum](https://jgvjg48436.lithium.com/t5/Building-Power-Apps/SQL-premium-connector-alternative/m-p/688016) | All connectors included |
| Free on-ramps being removed (Dataverse for Teams, unmanaged developer environments) | [Deprecations](https://learn.microsoft.com/power-platform/important-changes-coming) | Free tier = the on-prem install for small user counts (business decision; *inference*) |
| Two limit systems (service protection per web server, 24 h entitlements) | [API limits overview](https://learn.microsoft.com/power-apps/maker/data-platform/api-limits-overview) | One protective rate limiter |
| Identity requires Entra and five admin roles for basic user management | [Control user access](https://learn.microsoft.com/power-platform/admin/control-user-access#review-admin-roles-you-need-to-complete-different-tasks) | Local accounts + optional SSO; one People screen |
| Telemetry spread across App Insights, PPAC, Purview, Live monitor | [Observability tools](https://learn.microsoft.com/power-platform/guidance/adoption/observability#tools) | One health page, one audit log, one Monitor; optional OTLP |
| Six web portals | [Maker portal](https://learn.microsoft.com/power-apps/maker/canvas-apps/intro-maker-portal) | One portal |
| SharePoint lists as a database: delegation quirks, weak ALM | [SharePoint delegation](https://learn.microsoft.com/power-apps/maker/canvas-apps/connections/connection-sharepoint-online#power-apps-delegable-functions-and-operations-for-sharepoint), [env var issues](https://learn.microsoft.com/troubleshoot/power-platform/dataverse/working-with-solutions/dataverse-environment-variables#symptoms) | Real tables in MySQL; spreadsheets import, not live-bind, by default (D8 already) |

**Not worth replicating**: PIM, conditional access engine, B2B guest model, PAYG via cloud subscriptions, licence auto-claim, per-web-server limits, Purview integration, six separate maker sites.

## Sources

- [Identity and access management guidance](https://learn.microsoft.com/power-platform/guidance/adoption/conditional-access)
- [Control user access with security groups and licenses](https://learn.microsoft.com/power-platform/admin/control-user-access)
- [Share a canvas app with guest users](https://learn.microsoft.com/power-apps/maker/canvas-apps/share-app-guests)
- [Overview of connectors for canvas apps](https://learn.microsoft.com/power-apps/maker/canvas-apps/connections-list)
- [Licensing overview for Power Platform](https://learn.microsoft.com/power-platform/admin/pricing-billing-skus)
- [Power Platform licensing FAQs](https://learn.microsoft.com/power-platform/admin/powerapps-flow-licensing-faq)
- [Pay-as-you-go plan](https://learn.microsoft.com/power-platform/admin/pay-as-you-go-overview)
- [Pay-as-you-go meters](https://learn.microsoft.com/power-platform/admin/pay-as-you-go-meters)
- [Pay-as-you-go known issues and FAQ](https://learn.microsoft.com/power-platform/admin/pay-as-you-go-issues-faq)
- [Deep dive on specific licenses (seeded)](https://learn.microsoft.com/power-platform/admin/power-automate-licensing/deep-dive-on-specific-license)
- [Tenant environment strategy (auto-claim)](https://learn.microsoft.com/power-platform/guidance/adoption/environment-strategy)
- [Dataverse API limits overview](https://learn.microsoft.com/power-apps/maker/data-platform/api-limits-overview)
- [Service protection API limits](https://learn.microsoft.com/power-apps/developer/data-platform/api-limits)
- [Requests limits and allocations](https://learn.microsoft.com/power-platform/admin/api-request-limits-allocations)
- [Dataverse search limits](https://learn.microsoft.com/power-apps/developer/data-platform/search/overview)
- [Monitoring and alerting strategy](https://learn.microsoft.com/power-platform/well-architected/reliability/monitoring-alerting-strategy)
- [Managed environments overview](https://learn.microsoft.com/power-platform/admin/managed-environment-overview)
- [Gain insights into adoption (observability tools)](https://learn.microsoft.com/power-platform/guidance/adoption/observability)
- [Get started with Power Apps (maker portal)](https://learn.microsoft.com/power-apps/maker/canvas-apps/intro-maker-portal)
- [Create a canvas app from a list](https://learn.microsoft.com/power-apps/maker/canvas-apps/app-from-sharepoint)
- [Create a model-driven app](https://learn.microsoft.com/power-apps/maker/model-driven-apps/create-model-driven-app)
- [Form designer (Copilot column suggestions)](https://learn.microsoft.com/power-apps/maker/model-driven-apps/create-and-edit-forms)
- [Embed a canvas app as personal app in Teams](https://learn.microsoft.com/power-apps/teams/embed-teams-app)
- [Embed a canvas app as tab app in Teams](https://learn.microsoft.com/power-apps/teams/embed-teams-tab)
- [Save and publish canvas apps](https://learn.microsoft.com/power-apps/maker/canvas-apps/save-publish-app)
- [Important changes (deprecations)](https://learn.microsoft.com/power-platform/important-changes-coming)
- [Dataverse for Teams vs Dataverse](https://learn.microsoft.com/power-apps/teams/data-platform-compare)
- [Connect to SharePoint (delegation)](https://learn.microsoft.com/power-apps/maker/canvas-apps/connections/connection-sharepoint-online)
- [Customizing SharePoint (forms)](https://learn.microsoft.com/sharepoint/extend-and-develop)
- [App performance considerations](https://learn.microsoft.com/power-apps/maker/canvas-apps/app-performance-considerations)
- [Data source environment variables troubleshooting](https://learn.microsoft.com/troubleshoot/power-platform/dataverse/working-with-solutions/dataverse-environment-variables)
- Anecdotal forum threads: [Licensing madness - scaling](https://powerusers.microsoft.com/t5/Building-Power-Apps/Licensing-madness-scaling/m-p/418262); [Help understanding powerapps license changes October 2019](https://powerusers.microsoft.com/t5/General-Discussion/Help-understanding-powerapps-license-changes-October-2019/m-p/355562); [SQL premium connector alternative](https://jgvjg48436.lithium.com/t5/Building-Power-Apps/SQL-premium-connector-alternative/m-p/688016)
