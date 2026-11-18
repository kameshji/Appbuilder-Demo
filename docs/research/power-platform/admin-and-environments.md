# Admin and environments

Research date: 18 November 2026. Sources are Microsoft Learn pages fetched on that date unless marked otherwise. Anything not confirmed on a fetched page is labelled *unverified*. Author's opinions are labelled *inference*.

## 1. The hierarchy: tenant, environment, database

Power Platform administration sits on three nested levels.

| Level | What it is | Who controls it |
|---|---|---|
| Tenant | The customer's Microsoft Entra ID directory. Identities, licences and tenant-wide settings live here. | Global admin, Power Platform admin, Dynamics 365 admin |
| Environment | A container for apps, flows, agents, connections and (optionally) one Dataverse database. It is the unit of security, region, backup and governance. | Environment admin / System Administrator security role inside it |
| Dataverse database | At most one per environment. Holds tables, security roles, business units and solutions. | System Administrator, System Customizer roles |

An environment is described by Microsoft as the place that stores and shares an organisation's data, apps and processes, and as the container that separates apps with different roles, security needs or audiences; [each environment can have only one Dataverse database](https://learn.microsoft.com/power-platform/alm/basics-alm). Microsoft's identity guidance calls the environment [the security boundary in Power Platform](https://learn.microsoft.com/power-platform/guidance/adoption/conditional-access#environment-access): a licence and a tenant identity are not enough to get in (except for the default environment); you also need a security role in that environment.

All of this is managed in the **Power Platform admin center** (PPAC), whose left navigation now groups things under *Manage* (environments, environment groups, tenant settings), *Licensing* (capacity and licence reports), *Monitor*, and *Security* ([environments overview](https://learn.microsoft.com/power-platform/admin/environments-overview)). Microsoft calls this the "new and improved" admin center and has rebranded the bundle of premium governance features as [*environment management*](https://learn.microsoft.com/power-platform/admin/environment-management-overview), grouped into managed security, managed governance, managed operations and managed availability.

## 2. Environment types

The current list, from the [environments overview](https://learn.microsoft.com/power-platform/admin/environments-overview#environment-types) and the [tenant environment strategy guidance](https://learn.microsoft.com/power-platform/guidance/adoption/environment-strategy):

| Type | Purpose | Backups | Counts against capacity | Notes |
|---|---|---|---|---|
| Default | One per tenant, created automatically, shared by everyone | System backups 7 days; no manual backups; cannot restore over it | Has its own small included quota (3 GB database, 3 GB file, 1 GB log) | Every licensed user gets the maker role. Cannot be deleted. Capped at 1 TB. Microsoft says it is meant for personal productivity, not production. |
| Production | Permanent work | 7 days default, up to 28 days if managed | Yes, needs 1 GB free to create | Region chosen at creation |
| Sandbox | Dev and test | 7 days | Yes | Supports copy, reset, administration mode |
| Developer | A single maker's personal space | 7 days | No | Unmanaged developer environments are **deprecated**: no new ones from 15 Nov 2026, existing ones keep working until 15 Dec 2026 unless converted to managed ([deprecation notice](https://learn.microsoft.com/power-platform/important-changes-coming#deprecation-of-unmanaged-developer-environments-and-the-power-apps-developer-plan)). Each user can create only one managed developer environment. |
| Trial | Short proofs of concept | Not backed up | No | Expires after 30 days; one per user |
| Dataverse for Teams | Lightweight environment bound to a Team | 7 days | No | **Deprecated**: no new ones from 15 Nov 2026 ([environments overview](https://learn.microsoft.com/power-platform/admin/environments-overview#environment-location)) |
| Support | Created by Microsoft support | n/a | No | |

Backup retention per type is tabulated on [Back up and restore environments](https://learn.microsoft.com/power-platform/admin/backup-restore-environments#supported-retention-period).

Two points from the current docs matter for us:

1. **The default environment is a known problem.** Microsoft's own guidance recommends renaming it to something like "Personal Productivity" and turning on *environment routing*, which sends every maker to their own managed developer environment when they open the maker portal ([managed governance](https://learn.microsoft.com/power-platform/admin/managed-governance#features-of-managed-governance)). This is a fix for a design where everyone could build in one shared space.
2. **Microsoft is cutting the free tiers.** Deprecating unmanaged developer environments and Dataverse for Teams pushes every serious maker toward premium-licensed managed environments. *Inference*: the free on-ramp for small organisations has shrunk.

### Who can create environments

Creation depends on licence. Microsoft 365 plans alone cannot create trial or production environments; a Power Apps or Power Automate plan can create one trial and production environments, and any production or sandbox environment needs 1 GB of free database capacity ([create environment](https://learn.microsoft.com/power-platform/admin/create-environment)). Admins can limit creation of each type (developer, production, trial) to "only specific admins" in tenant settings ([control environment creation](https://learn.microsoft.com/power-platform/admin/control-environment-creation)).

## 3. Environment groups and rules

An environment group is a folder of environments with rules applied to all members ([environment groups](https://learn.microsoft.com/power-platform/admin/environment-groups)):

- Groups can contain **only managed environments**; an environment belongs to one group; groups cannot be nested.
- A published rule is enforced on every member and the matching setting becomes read-only inside each environment. Per-environment exceptions are not supported.
- When an environment leaves the group it keeps the last applied settings but becomes editable again.
- Rules now come from a **rules gallery** with categories (security, compliance, cost, lifecycle, maker governance) and default configurations; most can be applied with defaults ([rules gallery](https://learn.microsoft.com/power-platform/admin/environment-group-rules-gallery)).

The rule catalogue ([rules for environment groups](https://learn.microsoft.com/power-platform/admin/environment-groups-rules)) includes: Copilot Studio transcript access, advanced connector policy, AI prompts, AI-generated descriptions, Copilot features, backup retention, drawing from the tenant credit pool, default deployment pipeline, generative AI settings, sharing limits, solution checker enforcement, usage insights and others.

Microsoft's own motivating example is dev/test vs production groups: relaxed rules for one, solution checker, no unmanaged changes and longer backups for the other.

## 4. Managed environments

Managed environments are a premium add-on state of an environment. The [overview](https://learn.microsoft.com/power-platform/admin/managed-environment-overview) lists 21 features, including: environment groups, sharing limits, weekly usage insights, data policies, pipelines, maker welcome content, solution checker enforcement, IP firewall, IP cookie binding, customer-managed keys, Lockbox, extended backup, desktop-flow data policies, export to Application Insights, catalog, environment routing, VNet support, conditional access per app, app allow-listing and masking rules.

Licensing: the entitlement comes with standalone Power Apps, Power Automate, Copilot Studio, Power Pages and Dynamics 365 licences, and is *not* in the Developer Plan ([overview](https://learn.microsoft.com/power-platform/admin/managed-environment-overview)). In practice this means everyone who runs an app in a managed environment needs a premium licence; the auto-claim policy can assign a Power Apps per-user licence automatically to anyone who opens an app in a managed environment ([environment strategy](https://learn.microsoft.com/power-platform/guidance/adoption/environment-strategy#features-that-support-an-enterprise-scale,-environment-strategy)).

*Inference*: "managed" is less a technical concept than a licensing gate around governance features. Many of these features (sharing limits, usage insights, longer backups) are basic hygiene that a small product should include by default.

## 5. Data policies (DLP) for connectors

Data policies decide which connectors may be used, and which may be combined, inside one app or flow ([data policy strategy](https://learn.microsoft.com/power-platform/guidance/adoption/dlp-strategy)).

| Concept | Behaviour |
|---|---|
| Groups | Every connector is in **Business**, **Non-Business** or **Blocked**. An app or flow can use connectors from Business or from Non-Business, never both. Blocked cannot be used at all. The labels have no meaning beyond the grouping. |
| Default group | New connectors land in the default group, Non-Business unless changed ([connector classification](https://learn.microsoft.com/power-platform/admin/dlp-connector-classification)). |
| Unblockable | Microsoft-owned standard connectors and core Dataverse connectors cannot be blocked. |
| Scope | Tenant-level or environment-level. Environment policies cannot override tenant policies; when several apply, the most restrictive combination wins. Not per user. |
| Custom connectors | Classified at environment level by name, or at tenant level by URL pattern rules ordered with a final `*` rule (default Ignore). |
| HTTP connectors | HTTP, HTTP Webhook and the request trigger are classifiable. Child flows depend internally on HTTP, so blocking HTTP can break child flows. |
| Enforcement | At design time (the app refuses to add the connection) and at run time (a violating flow is saved but **suspended**) ([impact on apps and flows](https://learn.microsoft.com/power-platform/admin/dlp-impact-policies-apps-flows)). |
| Limitation | Policies are connector-aware but not connection-aware: they cannot tell a dev SQL server from a prod one. |

There is now a second generation: **advanced connector policies (ACP)**. ACP replaces the three-group model with a default-deny allowlist down to the action level, enforced at design time, configurable per environment or environment group. It currently covers certified connectors only (not custom or HTTP), and runs either alongside classic policies (most restrictive wins) or alone ("ACP-only mode") ([advanced connector policies](https://learn.microsoft.com/power-platform/admin/advanced-connector-policies)).

*Inference*: two overlapping policy engines, with different coverage, is the kind of complexity a 30-person company should never see.

## 6. Capacity

Dataverse storage is sold and measured in three pools: **database** (rows and metadata), **file** (attachments, images, some system tables) and **log** (audit and plug-in trace logs) ([capacity storage](https://learn.microsoft.com/power-platform/admin/capacity-storage)). Each tenant gets a base entitlement plus per-licence accruals, more is bought in 1 GB increments, and recent changes let a deficit in one pool borrow unused capacity from others. Over capacity, admins cannot create, copy or restore environments (each needs 1 GB free) ([backup FAQ](https://learn.microsoft.com/power-platform/admin/backup-restore-environments#faq)).

Microsoft's [storage management page](https://learn.microsoft.com/power-platform/admin/storage-management#how-your-data-grows-over-time) is unusually candid: audit and plug-in logs are billed to the customer, default retention is often generous, search indexes are duplicated across dev/test/prod, and "environment sprawl is a major driver of storage cost and complexity".

## 7. Environment variables

Environment variables are solution components that hold values which change between environments ([overview](https://learn.microsoft.com/power-apps/maker/data-platform/environmentvariables#how-do-environment-variables-work)):

- Two tables: `environmentvariabledefinition` (schema name, type, **default value**) and `environmentvariablevalue` (the **current value** for this environment). Only one value per definition.
- Types: decimal number, text, JSON, yes/no, data source (for example a SharePoint site and list), and secret ([Power Automate docs](https://learn.microsoft.com/power-automate/environment-variables#create-environment-variables)).
- Secrets are references to Azure Key Vault only, usable only from flows, Copilot Studio agents and custom connectors, not canvas apps ([Key Vault secrets](https://learn.microsoft.com/power-apps/maker/data-platform/environmentvariables-azure-key-vault-secrets)). Setting this up requires registering a resource provider in an Azure subscription and granting Key Vault RBAC roles.
- Values are limited to 2,000 characters; changes can take up to an hour to reach apps and flows because values are pushed asynchronously and cached in browsers ([FAQ](https://learn.microsoft.com/power-apps/maker/data-platform/environment-variables-faq)).
- The solution import wizard prompts for values that have no default or current value.
- Data-source variables for SharePoint are a known trouble spot: two lists on the same URL in the source collapse into one value in the target ([troubleshooting](https://learn.microsoft.com/troubleshoot/power-platform/dataverse/working-with-solutions/dataverse-environment-variables#symptoms)).

## 8. Admin roles and security groups

| Role | Where defined | Scope |
|---|---|---|
| Global admin | Entra ID | Everything in the tenant |
| Power Platform administrator | Entra ID | All Power Platform admin functions regardless of environment security groups |
| Dynamics 365 administrator | Entra ID | Most admin functions, but only in environments whose security group they belong to |
| Environment admin / System Administrator | Dataverse security role per environment | One environment |
| Environment maker | Security role | Can create apps, flows, connections in that environment |

Source: [service admin roles](https://learn.microsoft.com/power-platform/admin/use-service-admin-role-manage-tenant) and [control user access](https://learn.microsoft.com/power-platform/admin/control-user-access#review-admin-roles-you-need-to-complete-different-tasks). Two details: tenant admins are **no longer automatically System Administrators** inside environments and must self-elevate (with Entra PIM recommended); and Power Platform admins cannot create users or assign licences, which needs User/License/Groups administrators in Entra.

**Security groups**: an Entra security group (or Microsoft 365 group) can be attached to an environment. Only licensed members are provisioned as users; attaching a group to an environment with existing users disables non-members; it cannot be used on default or developer environments; and members still need a security role to see any data ([control user access](https://learn.microsoft.com/power-platform/admin/control-user-access)).

So to give one new employee access to one app, an admin may touch: an Entra user, a licence, a security group, the environment's security role, and the app's share list. *Inference*: that is five places for what a small business sees as one decision.

## 9. Auditing and monitoring

| Tool | What it covers |
|---|---|
| Dataverse auditing | Row and column level change history, configured per environment, table and column; stored in log capacity (see `dataverse.md`) |
| Activity logs in Microsoft Purview | Maker and admin activity for Power Apps, Power Automate, Power Pages, connectors, Copilot Studio, Dataverse, admin actions. Requires turning on per production environment; only production environments; events arrive within about 24 hours, so not real-time ([activity logs overview](https://learn.microsoft.com/power-platform/admin/activity-logging-auditing/activity-logs-overview), [monitoring strategy](https://learn.microsoft.com/power-platform/well-architected/reliability/monitoring-alerting-strategy#power-platform-facilitation)) |
| PPAC Monitor area | Operational health metrics for apps and flows, for makers and admins |
| Application Insights export | Dataverse, canvas app, cloud flow and Copilot Studio telemetry into Azure Monitor (managed environments feature) |
| Analytics and licence reports | Active users, app usage, connector usage, flow run counts ([governance considerations](https://learn.microsoft.com/power-platform/admin/governance-considerations#monitor)) |
| Environment history | Timeline of create/copy/reset/edit for an environment; deleted together with the environment ([environments overview](https://learn.microsoft.com/power-platform/admin/environments-overview#environment-location)) |

Purview audit logs record flow lifecycle and permission events, not runs; for runs you go to Application Insights, Dataverse run records or PPAC analytics ([Power Automate activity logs](https://learn.microsoft.com/power-platform/admin/activity-logging-auditing/activity-logs-power-automate)). Four tools, four retention models.

## 10. Backup, restore and copy

From [Back up and restore environments](https://learn.microsoft.com/power-platform/admin/backup-restore-environments):

- **System backups** are continuous (Azure SQL automated backups). Retention is 7 days, extendable to 7/14/21/28 days only for production managed environments. Trials are not backed up.
- **Manual backups** are just labelled timestamps on the continuous backup, not separate copies. Unlimited count, same retention.
- **Restore** goes to a sandbox (production can be restored only into a sandbox; the default environment only into a developer environment), needs 1 GB free capacity, same region. Only apps and flows that are inside a Dataverse solution are included.
- **You cannot download a backup.** Moving data out requires export to Excel or third-party migration tools.
- To recover rows after a mass delete, restore a backup into a new environment and copy the rows back.
- Deleted environments can be recovered within 7 days.

**Copy environment** overwrites a sandbox target with either everything or customizations and schema only; the target ends up in administration mode with background operations turned off ([copy environment](https://learn.microsoft.com/power-platform/admin/copy-environment#how-to-copy-an-environment)). **Reset** wipes a sandbox.

## How to replicate on our stack (single Node server + MySQL)

Our install is one Node process, one MySQL schema and one workspace folder. That already is a "tenant" and an "environment". The question is how much of the environment concept to add.

**Proposal: an environment is a MySQL schema plus a workspace subfolder, managed by the same Node process.**

| Microsoft concept | Appbuilder design | What exists today |
|---|---|---|
| Tenant | The install. `server.json` + the admin users. | Exists |
| Environment | Row in a new `ab_environments` table in a small *control* schema: `id, name, kind ('production'|'test'|'personal'), db_name, workspace_dir, created_by, created_on, status`. Each environment gets its own MySQL schema `ab_env_<slug>` with the existing `ab_*` tables. | One implicit environment |
| Default environment | Do not create one. The first environment is "Production"; makers get one personal sandbox each only if the admin turns that on. | n/a |
| Environment routing | The portal opens the last-used environment; a switcher in the top bar lists the ones the user may enter. | n/a |
| Security group on environment | `ab_environment_members(env_id, user_id, role_id)`; users are global (one login), membership is per environment. | Users and roles exist, single scope |
| Admin roles | Two built-in global roles: **Owner** (install admin: backups, environments, licences, SMTP) and **Environment admin** (inside one environment). Keep the existing `is_admin` / `is_maker` role flags inside environments. | Partly |
| Environment variables | `ab_env_vars(name, type, default_value, description)` stored in the solution, and `ab_env_var_values(name, value_sealed)` per environment. Types: text, number, yes/no, JSON, connection, secret. Secrets sealed with the existing workspace secret key (`server/core/secrets.ts`), usable by apps on the server side only (flows, connectors), never sent to the browser. Fx gets `EnvVar("name")` for non-secret values. | Sealed connection secrets exist |
| Data policies | A per-environment allowlist of connector *types* plus a per-connection "allowed in environments" list. No Business/Non-Business groups. | Connections exist |
| Capacity | Show actual MySQL size per environment (`information_schema.tables`) and attachment folder size on the admin dashboard. No quotas, because the customer owns the disk. | n/a |
| Backup | Scheduled `mysqldump --single-transaction` of each environment schema plus a tar of its workspace folder, to a configurable folder, retention N days; a "Back up now" button; restore into a new environment or over a test environment. **Downloadable**, because it is their data. | Not built |
| Copy environment | Dump/restore into a new schema with option "schema and apps only" (no rows) for making a test copy. Mark copies so flows and outgoing email are paused after copy (Microsoft's administration-mode idea is a good one). | Not built |
| Auditing | Keep `ab_audit`, add `env_id`, a `category` column (data, security, maker, admin) and a retention setting with a nightly purge. One audit viewer with filters, CSV export. | `ab_audit` exists |
| Monitoring | A health page: server uptime, DB reachability, flow run failures in last 24 h, failed sign-ins, disk free, last backup age. | `/status` exists |
| Environment groups, rules gallery | Skip. | |

Services to add: `EnvironmentManager` (create, list, switch, copy, delete; one MySQL pool per environment, lazily opened), `BackupService` (scheduler, dump, restore, retention), `AuditService` (already partly in `DataService`). APIs: `GET/POST /api/v1/admin/environments`, `POST /admin/environments/:id/copy`, `POST /admin/backups`, `GET /admin/backups`, `POST /admin/backups/:id/restore`, `GET /admin/audit?env=&category=&from=&to=`, `GET/PUT /api/v1/env-vars`.

The main architectural caution: the server today keeps security caches and sessions in process memory (architecture.md). Caches must be keyed by environment id from day one.

## Where we can be better for a 20-50 person org

| Microsoft pain point | Evidence | Simpler design |
|---|---|---|
| A shared default environment where everyone can build, then a stack of features (routing, managed developer environments, renaming advice) to undo the damage | [Managed governance](https://learn.microsoft.com/power-platform/admin/managed-governance#features-of-managed-governance), [default environment section](https://learn.microsoft.com/power-platform/admin/environments-overview#default-environment) | No default free-for-all. Production plus Test, makers are explicitly granted. |
| Basic governance gated behind "managed environments" and premium licences | [Managed environment licensing](https://learn.microsoft.com/power-platform/admin/managed-environment-overview) | Sharing limits, usage stats, backup retention and audit are always on. |
| Environment sprawl drives storage cost | Microsoft's own [storage management page](https://learn.microsoft.com/power-platform/admin/storage-management#how-your-data-grows-over-time) | A small fixed number of environments (suggest max 5 by default), disk usage visible on one page. |
| Backups you cannot download, short retention, restore only to sandbox | [Backup FAQ](https://learn.microsoft.com/power-platform/admin/backup-restore-environments#faq) | Plain SQL dumps on the customer's disk or NAS, any retention, restore in place. This is a selling point for an on-prem buyer. |
| Two overlapping connector policy systems with partial coverage | [ACP](https://learn.microsoft.com/power-platform/admin/advanced-connector-policies) | One allowlist per environment. |
| Five places to grant one person access to one app | [Control user access](https://learn.microsoft.com/power-platform/admin/control-user-access) | One "Add person" dialog: name, email, role(s), environments. |
| Secrets require Azure Key Vault and an Azure subscription | [Key Vault env vars](https://learn.microsoft.com/power-apps/maker/data-platform/environmentvariables-azure-key-vault-secrets) | Secrets sealed locally with the install key. |
| Environment variable changes take up to an hour | [FAQ](https://learn.microsoft.com/power-apps/maker/data-platform/environment-variables-faq) | Read at request time; instant. |
| Audit logs delayed ~24 h and split across Purview, Dataverse and App Insights | [Monitoring strategy](https://learn.microsoft.com/power-platform/well-architected/reliability/monitoring-alerting-strategy#power-platform-facilitation) | One audit table, real-time, one viewer. |

**Not worth replicating for this market**: environment groups and the rules gallery, tenant vs environment policy precedence, capacity pools and borrowing, regions, customer-managed keys, Lockbox, IP cookie binding, VNet, trial environments, the 21-item managed-environment list. A 30-person manufacturer has one IT-minded person at most; the admin console should fit on one screen per topic.

**Worth copying**: the idea that a copied environment comes up with background jobs and outgoing messages paused; environment variables with default vs current value and a prompt on import; the per-environment membership model; design-time *and* run-time enforcement of connector policy.

## Sources

- [Power Platform environments overview](https://learn.microsoft.com/power-platform/admin/environments-overview)
- [Create and manage environments](https://learn.microsoft.com/power-platform/admin/create-environment)
- [Important changes (deprecations) coming](https://learn.microsoft.com/power-platform/important-changes-coming)
- [Tenant environment strategy](https://learn.microsoft.com/power-platform/guidance/adoption/environment-strategy)
- [ALM basics](https://learn.microsoft.com/power-platform/alm/basics-alm)
- [Managed environments overview](https://learn.microsoft.com/power-platform/admin/managed-environment-overview)
- [Environment management capabilities](https://learn.microsoft.com/power-platform/admin/environment-management-overview)
- [Managed governance](https://learn.microsoft.com/power-platform/admin/managed-governance)
- [Environment groups](https://learn.microsoft.com/power-platform/admin/environment-groups)
- [Environment group rules gallery](https://learn.microsoft.com/power-platform/admin/environment-group-rules-gallery)
- [Rules for environment groups](https://learn.microsoft.com/power-platform/admin/environment-groups-rules)
- [Data policy strategy](https://learn.microsoft.com/power-platform/guidance/adoption/dlp-strategy)
- [Connector classification](https://learn.microsoft.com/power-platform/admin/dlp-connector-classification)
- [Impact of data policies on apps and flows](https://learn.microsoft.com/power-platform/admin/dlp-impact-policies-apps-flows)
- [Advanced connector policies](https://learn.microsoft.com/power-platform/admin/advanced-connector-policies)
- [Dataverse capacity-based storage details](https://learn.microsoft.com/power-platform/admin/capacity-storage)
- [Storage management in Dataverse](https://learn.microsoft.com/power-platform/admin/storage-management)
- [Environment variables overview](https://learn.microsoft.com/power-apps/maker/data-platform/environmentvariables)
- [Environment variables FAQ](https://learn.microsoft.com/power-apps/maker/data-platform/environment-variables-faq)
- [Environment variables for Azure Key Vault secrets](https://learn.microsoft.com/power-apps/maker/data-platform/environmentvariables-azure-key-vault-secrets)
- [Create environment variables (Power Automate)](https://learn.microsoft.com/power-automate/environment-variables)
- [Data source environment variables troubleshooting](https://learn.microsoft.com/troubleshoot/power-platform/dataverse/working-with-solutions/dataverse-environment-variables)
- [Use service admin roles](https://learn.microsoft.com/power-platform/admin/use-service-admin-role-manage-tenant)
- [Control user access with security groups](https://learn.microsoft.com/power-platform/admin/control-user-access)
- [Control environment creation](https://learn.microsoft.com/power-platform/admin/control-environment-creation)
- [Identity and access management guidance](https://learn.microsoft.com/power-platform/guidance/adoption/conditional-access)
- [Activity logs and auditing in Microsoft Purview](https://learn.microsoft.com/power-platform/admin/activity-logging-auditing/activity-logs-overview)
- [Power Automate activity logs](https://learn.microsoft.com/power-platform/admin/activity-logging-auditing/activity-logs-power-automate)
- [Monitoring and alerting strategy](https://learn.microsoft.com/power-platform/well-architected/reliability/monitoring-alerting-strategy)
- [Governance considerations](https://learn.microsoft.com/power-platform/admin/governance-considerations)
- [Back up and restore environments](https://learn.microsoft.com/power-platform/admin/backup-restore-environments)
- [Copy an environment](https://learn.microsoft.com/power-platform/admin/copy-environment)
