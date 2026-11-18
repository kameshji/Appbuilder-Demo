# Dataverse

Research date: 18 November 2026. Sources are Microsoft Learn pages retrieved on that date. Opinions are labelled *inference*. Claims not confirmed on a fetched page are labelled *unverified*.

Dataverse is the metadata-driven relational store under Power Apps, Power Automate, Power Pages, Copilot Studio and Dynamics 365. It is the most copied and most important part of the platform for us: our tables, roles, row filters and column security are already a small Dataverse.

## 1. Tables

### Table types

| Type | What it is | Key limits |
|---|---|---|
| Standard | Normal relational table (system "out-of-box" tables such as Account, Contact, User, plus custom tables) | |
| Activity | A table with time dimensions (subject, start, end, due, duration) and states open/completed/cancelled. Built-in examples: appointment, email, phone call, task, letter, fax. Shown together in a timeline. | Must be user- or team-owned, never organization-owned ([types of tables](https://learn.microsoft.com/power-apps/maker/data-platform/types-of-entities#activity-tables)) |
| Virtual | Rows live in an external source and are fetched at run time through a data provider | Organization-owned only, no row-level security filtering, no field security, no auditing, no search, no charts or dashboards, no offline, no calculated or rollup columns; must have a GUID key; cannot be converted to or from standard ([virtual table limitations](https://learn.microsoft.com/power-apps/developer/data-platform/virtual-entities/get-started-ve#limitations-of-virtual-tables)) |
| Elastic | Backed by Azure Cosmos DB for tens of millions of rows, flexible schema, time-to-live auto-delete; billed against **log** capacity | No business rules, charts, business process flows, N:N to standard tables, alternate keys, calculated/rollup/currency/formula columns, cascades, sharing, access teams, data import/export; queries return 500 rows by default ([elastic tables](https://learn.microsoft.com/power-apps/maker/data-platform/create-edit-elastic-tables#elastic-tables-feature-support)) |

### Ownership

Chosen at creation and **cannot be changed later** ([types of tables](https://learn.microsoft.com/power-apps/maker/data-platform/types-of-entities#table-ownership)):

| Ownership | Behaviour |
|---|---|
| User or team | Each row has an owner (user or team). Privileges can be scoped User / Business Unit / Parent-Child BU / Organization. Rows can be assigned and shared. |
| Organization | No owner. A privilege is all-or-nothing. |
| Filtered (preview) | No owner; access granted by column-value filters attached to security role privileges, for example "City = Redmond". No assign or share. Filters can also be applied to existing user- and organization-owned tables ([table definitions](https://learn.microsoft.com/power-apps/developer/data-platform/entity-metadata#types-of-tables), [ownership-based security](https://learn.microsoft.com/power-platform/admin/wp-security-cds#table-and-record-ownership)). |

The **Filtered** option is notable: Microsoft is adding exactly what Appbuilder already has (`rowFilter` conditions on a role privilege). *Inference*: this validates our model; theirs is still in preview.

## 2. Columns

From [types of columns](https://learn.microsoft.com/power-apps/maker/data-platform/types-of-fields) and [create columns](https://learn.microsoft.com/power-apps/maker/data-platform/create-edit-field-portal#column-data-types):

| Family | Types | Notes |
|---|---|---|
| Text | Single line (formats email, phone, URL, ticker, text area; up to 4,000 chars), multiline (up to 1,048,576 chars) | |
| Numbers | Whole number (formats duration, language, time zone), decimal (10 places), floating point (5 places), currency, big integer | Currency carries an exchange rate and a base-currency shadow column |
| Date | Date only, date and time; behaviours user-local, date-only, time-zone independent | Business rules evaluate date-only in UTC by default ([business rules](https://learn.microsoft.com/power-apps/maker/data-platform/data-platform-create-business-rule#localize-error-messages-used-in-business-rules)) |
| Choice | Choice (single), choices (multi-select), yes/no; local or global option sets | Multi-select cannot be used in workflows, business rules, charts, rollups or calculated columns |
| Relationship | Lookup (single target), customer (account or contact), owner, multi-value party list | |
| System | Status and status reason, autonumber | |
| Binary | File (default max 32 MB, up to 131 MB per column, stored outside the relational store), image (one primary image per table; GIF/JPEG/BMP/PNG only) ([image column data](https://learn.microsoft.com/power-apps/developer/data-platform/image-column-data#image-file-types)) | File columns don't work with business rules, charts, calculated or rollup columns; upload/delete on a form is immediate, not on save |
| Computed | Calculated, rollup, formula (Power Fx), prompt (AI result stored in the column) | See below |

**Required** has two levels: *Business Required* is enforced only by the app UI; only *System Required* is enforced on API writes, and makers can't set it ([create columns](https://learn.microsoft.com/power-apps/maker/data-platform/create-edit-field-portal#searching-and-sorting-columns)). *Inference*: a classic source of bad data — a flow or import bypasses "required". Our server enforces `required` on every write, which is better.

### Three generations of computed columns

| Kind | When computed | Notable limits |
|---|---|---|
| Calculated | On read | Can chain; null arithmetic gives null |
| Rollup | Async system jobs: a mass recalculation scheduled **12 hours** after the column is created or changed, then incremental recalculation at most hourly; a manual "recalculate" on the form limited to 50,000 related rows | 200 per environment and 50 per table by default; 1:N only; no rollup of a rollup; computed as system user so everyone sees the same value ([rollup columns](https://learn.microsoft.com/power-apps/maker/data-platform/define-rollup-fields#rollup-calculations)) |
| Formula (Power Fx) | On fetch | Max 1,000 characters, depth 10, no workflows or plug-ins triggered on them, no currency output, many text/number coercion restrictions, null treated as 0 (unlike calculated columns) ([formula columns](https://learn.microsoft.com/power-apps/maker/data-platform/formula-columns#guidelines-and-limitations)) |

*Inference*: three overlapping mechanisms with different null semantics is an anti-pattern we should avoid by having one.

## 3. Relationships

- 1:N (lookup on the child), N:1 (same thing from the other side), N:N (hidden intersect table).
- Each 1:N has **cascade behaviours** for assign, delete, reparent, share and unshare. Delete can be *Cascade All*, *Remove Link* or *Restrict*. A table may have only one *parental* (cascading) relationship, which prevents multi-parent cascades ([relationships](https://learn.microsoft.com/power-apps/maker/data-platform/create-edit-entity-relationships#table-relationship-behavior)).
- Shared access cascades through related records: if record A is shared with you and record B is related, you may get access to B too ([how access is determined](https://learn.microsoft.com/power-platform/admin/how-record-access-determined#access-check)).

## 4. Alternate keys

An alternate key is one or more columns declared unique so external systems can address a row without the GUID, mainly for upsert from integrations ([alternate keys](https://learn.microsoft.com/power-apps/developer/data-platform/define-alternate-keys-entity)). Implemented as a unique index created by an async job (*unverified* detail on async index creation; not on the page fetched).

## 5. Business rules

Declarative if/else rules attached to a table ([business rules](https://learn.microsoft.com/power-apps/maker/data-platform/data-platform-create-business-rule), [form business rules](https://learn.microsoft.com/power-apps/maker/model-driven-apps/create-business-rules-recommendations-apply-logic-form)):

| Action | Scope |
|---|---|
| Set value, clear value, set default, show error (blocks save) | All scopes, including server side ("entity" scope runs as a synchronous plug-in) |
| Lock/unlock, show/hide, set required, recommendation | Model-driven forms only; ignored on the server |

Limits: canvas apps support only part of it; no multi-select choices, file or language columns; more than 150 rules per table degrades performance; one if-condition branch per rule in the editor.

## 6. Security model in detail

### Layers

1. **Environment access**: security group membership and at least one security role (see `admin-and-environments.md`).
2. **Privilege check**: does any of the user's roles (directly or via a team) grant the privilege (Create, Read, Write, Delete, Append, Append To, Assign, Share) on this table? ([security roles](https://learn.microsoft.com/power-platform/admin/security-roles-privileges#role-name-and-description-of-a-security-role))
3. **Access check**: for this specific row, does the user have access through **ownership**, **role access level**, **sharing**, or **hierarchy**? ([how record access is determined](https://learn.microsoft.com/power-platform/admin/how-record-access-determined#privilege-check))
4. **Column security**: for secured columns, does a column security profile grant Read / Read unmasked / Create / Update? ([column-level security](https://learn.microsoft.com/power-platform/admin/field-level-security))

Privileges are **cumulative**: a user gets the broadest access from all roles and teams; one role cannot take away what another grants ([ownership-based security](https://learn.microsoft.com/power-platform/admin/wp-security-cds)).

### Business units and access levels

Business units (BUs) form a tree under a root BU. Every user belongs to exactly one BU, and each BU has a default team. Access levels on each privilege:

| Level | Rows covered |
|---|---|
| None | Nothing |
| User | Rows the user owns, rows owned by their teams, rows shared with them or their teams |
| Business Unit | All rows owned in the user's BU |
| Parent: Child Business Unit | The user's BU and every BU below it |
| Organization | Everything |

Organization-owned tables only offer Organization or None ([security roles](https://learn.microsoft.com/power-platform/admin/security-roles-privileges#role-name-and-description-of-a-security-role)). Roles have a "member's privilege inheritance" setting: *team privileges only* vs *direct user and team privileges*.

### Teams

| Team type | Owns rows | Has roles | Use |
|---|---|---|---|
| Owner team | Yes | Yes | A group that collectively owns records |
| Access team | No | No | Ad hoc per-record collaboration; members get the rights the row was shared with; can be auto-created from an access team template |
| Microsoft Entra group team | Yes (owner type) | Yes | Membership synced from an Entra security or Microsoft 365 group; Microsoft recommends these for consistency ([access controls](https://learn.microsoft.com/azure/azure-sovereign-clouds/public/access-controls-dataverse-power-platform#security-roles)) |

([team types comparison](https://learn.microsoft.com/dynamics365/sustainability/well-architected/sustainability-hierarchical-security#security-set-up-fundamentals))

### Sharing

The owner (with Share privilege) can grant a specific user or team Read, Write, Append, Assign, Share or Delete on one row. Microsoft explicitly advises using sharing for exceptions only because it performs worse and is harder to troubleshoot ([ownership-based security](https://learn.microsoft.com/power-platform/admin/wp-security-cds#record-sharing)). A "Check Access" command shows how a user got access to a row, but seeing who else has access requires toggling hidden organisation settings via an *OrganizationSettingsEditor* tool ([access check](https://learn.microsoft.com/power-platform/admin/how-record-access-determined#access-check)).

### Hierarchy security

Optional extension: a manager gets access to rows owned by direct reports (manager hierarchy, same or parent BU) or by people below them in a position tree (position hierarchy, across BUs) ([hierarchy security](https://learn.microsoft.com/power-platform/admin/hierarchy-security)). The manager must also hold a BU or Parent:Child BU access level.

### Column-level security

Enable "secured" on a column, then create a column security profile granting Read (optionally masked), Read unmasked, Create, Update to users or teams. Unsecured by default; once secured, **only System Administrators see it** until a profile grants access. Column security never grants row access. **System administrators always see everything** ([column-level security](https://learn.microsoft.com/power-platform/admin/field-level-security)). Per-row column sharing also exists ([column security by code](https://learn.microsoft.com/power-apps/developer/data-platform/column-level-security#provide-access-to-secured-columns)). Masking rules (regex-based partial display) are a managed-environment feature.

### Comparison with what Appbuilder has

| Dataverse | Appbuilder today (`src/platform/contracts.ts`, `server/core/security.ts`) |
|---|---|
| Privileges C/R/W/D/Append/AppendTo/Assign/Share | `create` boolean, `read`/`update`/`delete` scopes |
| Access levels User/BU/Parent-Child/Org | Scopes `none`/`own`/`all` |
| Filtered ownership (preview) | `rowFilter: RowCondition[]` with `@me`, `@myEmail` tokens — already shipped |
| Column security profiles, separate from roles | Per-role `columns: Record<col, 'none'|'read'|'update'>` — simpler and colocated |
| Owner teams | Not built |
| Sharing, access teams | Not built |
| Hierarchy security | Not built |
| Admins bypass column security | Admin roles ignore CLS (same) |

## 7. Plug-ins and the event pipeline

Every operation is a *message* (Create, Update, Delete, Retrieve, Associate, custom API...) that passes through stages ([event framework](https://learn.microsoft.com/power-apps/developer/data-platform/event-framework#event-execution-pipeline)):

| Stage | Inside DB transaction? | Typical use |
|---|---|---|
| PreValidation (10) | Usually not (participates if the call came from inside another transaction); runs **before security checks** | Reject early, cheaply |
| PreOperation (20) | Yes | Change incoming values |
| MainOperation (30) | Yes | Platform only (and custom APIs, virtual table providers) |
| PostOperation (40) | Yes for sync; async steps run later outside | Side effects, follow-up writes |

- **Synchronous** steps block the request; an exception rolls back the whole transaction and the message reaches the user. **Asynchronous** steps are allowed only in PostOperation; they go to the system job queue (`AsyncOperation` table) and failures are logged there ([register a plug-in](https://learn.microsoft.com/power-apps/developer/data-platform/register-plug-in#step-registration), [handle exceptions](https://learn.microsoft.com/power-apps/developer/data-platform/handle-exceptions)).
- Multiple steps on the same message/stage are ordered by an execution order number; registrations live in `SdkMessageProcessingStep`.
- Classic plug-ins are .NET Framework assemblies uploaded to Dataverse. The low-code path is **Power Fx "automated low-code plug-ins"** (create/update/delete, pre or post operation) and **Dataverse functions** (formerly instant low-code plug-ins: Power Fx with typed inputs and outputs, callable from apps and flows). Both are **preview**, and instant plug-ins were deprioritised in favour of functions ([low-code plug-ins](https://learn.microsoft.com/power-apps/maker/data-platform/low-code-plug-ins), [functions](https://learn.microsoft.com/power-apps/maker/data-platform/functions-overview)).
- Transaction rules: sync pre/post plug-ins and sync workflows run inside the platform transaction and lengthen locks; async plug-ins and async workflows don't create a transaction, so each request inside commits on its own ([database transactions](https://learn.microsoft.com/power-apps/developer/data-platform/scalable-customization-design/database-transactions#customization-requests)).

## 8. Web API (OData v4)

- REST endpoint at `[org]/api/data/v9.2/`, OData v4 with `$select`, `$filter`, `$orderby`, `$expand`, `$top`, `$count`, `$apply` aggregation; `$skip`, `$search` and `$format` are **not supported** ([query overview](https://learn.microsoft.com/power-apps/developer/data-platform/webapi/query/overview#odata-query-options)).
- Default and maximum page size 5,000 rows (500 for elastic). Paging uses `Prefer: odata.maxpagesize` and an opaque `@odata.nextLink` skip token; order on a unique column to avoid duplicates across pages ([page results](https://learn.microsoft.com/power-apps/developer/data-platform/webapi/query/page-results)).
- `$count` is capped at 5,000; beyond that you get a "limit exceeded" flag and must use a 24-hour-stale snapshot function ([count rows](https://learn.microsoft.com/power-apps/developer/data-platform/webapi/query/count-rows)).
- GET URLs are limited to 32 KB; `$batch` raises this to 64 KB.
- FetchXML (proprietary XML query language) is still the more capable query path and is needed for retained data.

## 9. Change tracking

Enable on a table, then request with `Prefer: odata.track-changes`; the response carries an opaque `@odata.deltaLink`; calling it returns rows created, updated and deleted since. `$filter`, `$orderby`, `$expand` and `$top` aren't allowed on change-tracking requests ([change tracking](https://learn.microsoft.com/power-apps/developer/data-platform/use-change-tracking-synchronize-data-external-systems#retrieve-changes-for-a-table-using-the-web-api)).

## 10. Auditing

Three switches: environment, table, column ([manage auditing](https://learn.microsoft.com/power-platform/admin/manage-dataverse-auditing#configure-auditing-for-an-environment)). The organisation row holds `IsAuditEnabled`, `AuditRetentionPeriodV2` (default 30 days per the developer docs, "Forever" by default in the admin UI; 1 to 365,000 days), user-access logging and its interval (4 hours) ([configure auditing](https://learn.microsoft.com/power-apps/developer/data-platform/auditing/configure)). Each audit row is stamped with the retention in force when written; changing retention doesn't affect existing rows. Read logging goes to Purview for production environments only. Audit data consumes log capacity, which Microsoft bills ([storage management](https://learn.microsoft.com/power-platform/admin/storage-management#how-your-data-grows-over-time)).

## 11. Search

Dataverse search is a separately maintained relevance index (enabled per environment, columns opted in). Formula, image and multi-value lookup columns can't be searched; most types are searchable by default but **not sortable** by default ([searching and sorting](https://learn.microsoft.com/power-apps/maker/data-platform/types-of-fields#prompt-columns)). Search indexes add storage and are duplicated across environments ([storage management](https://learn.microsoft.com/power-platform/admin/storage-management#how-your-data-grows-over-time)). The index technology is not named on the pages fetched (*unverified*; commonly reported as Azure AI Search). Dataverse search also feeds Copilot grounding (see `copilot-studio.md`).

## 12. Long-term retention

Admins enable a table for retention and create a policy: a saved view as criteria, a start date and a frequency. Matching parent rows and their cascade children, attachments and images move to a managed data lake, read-only, queried through FetchXML with `datasource="retained"` (not OData). A run takes **72 to 96 hours** regardless of volume, can't be stopped, consumes API requests, and data **can never be moved back** ([LTR overview](https://learn.microsoft.com/power-apps/maker/data-platform/data-retention-overview#how-it-works), [set a policy](https://learn.microsoft.com/power-apps/maker/data-platform/data-retention-set#setup-a-retention-policy), [developer](https://learn.microsoft.com/power-apps/developer/data-platform/long-term-retention)). Audit and elastic tables are not supported.

## How to replicate on our stack (single Node server + MySQL)

We already have: `ab_tables` (definition JSON per table), physical MySQL user tables, `ab_roles` / `ab_role_tables` with scopes, row filters and column access, `ab_attachments`, `ab_audit`, autonumber, lookups, choice, file and image. The plan is to deepen this, not to copy Dataverse wholesale.

### Data model additions

| Feature | Design | Effort |
|---|---|---|
| Owner column semantics | Keep `owner` system column (user id). Add optional `owner_team_id` so a row can be team-owned. | S |
| Teams | `ab_teams(id, name, description)`, `ab_team_members(team_id, user_id)`, `ab_team_roles(team_id, role_id)`. A user's effective roles = direct roles ∪ team roles. Scope `own` widens to "owned by me or by any team I'm in". | M |
| Department scope (lightweight BU) | One optional `department` per user (`ab_users.department_id`, flat or one-level tree `ab_departments(id, name, parent_id)`). Add scope value `team` (rows owned by people in my department). That is our "Business Unit" level; skip Parent:Child unless a pilot needs it. | M |
| Sharing | `ab_shares(table_id, row_id, principal_type, principal_id, can_read, can_update, can_delete, shared_by, shared_on)`; the row predicate becomes `(<scope predicate>) OR id IN (SELECT row_id FROM ab_shares WHERE ...)`. Ship later; flag as "exceptions only" in the UI. | M |
| Hierarchy | `ab_users.manager_id` and a scope value `reports` (rows owned by me or anyone below me, depth-limited, computed with a recursive CTE — MySQL 8 / MariaDB 10.2+). Only if a customer asks. | M |
| Masking | Extend `ColumnAccess` with `'masked'` plus a per-column mask pattern (last 4 digits, email domain). | S |
| Computed columns | **One** mechanism: `formula` columns using our Fx engine evaluated **on the server** (needs server-side Fx, which architecture.md says doesn't exist yet). Simple same-row formulas compile to MySQL generated columns (`GENERATED ALWAYS AS (...) STORED`) where translatable so they can be filtered and sorted; others are computed on read. | L |
| Rollups | A `rollup` column type = `{ child table, lookup column, aggregate, filter }`. Compute with a SQL aggregate maintained by after-write hooks in `DataService` (recompute the parent row's value in the same transaction). No 12-hour jobs. | M |
| Alternate keys | We already have `unique`. Add composite unique keys on `TableDef.keys: string[][]` → MySQL `UNIQUE KEY`, and an `upsert` endpoint keyed on them for imports and connectors. | S |
| Relationships | Lookups exist. Add per-lookup `onDelete: 'restrict' | 'removeLink' | 'cascade'` implemented in `DataService` (transactional on MySQL). Add N:N via a generated link table. | M |
| Activity-like timeline | Don't build activity tables. Build a generic `ab_notes(table_id, row_id, kind, body, attachment_ids, created_by, created_on)` plus a Timeline control. Covers notes, calls, emails logged by flows. | S |
| Virtual tables | We already have connectors (MySQL, files, Google Sheets) behind one interface, with our security applied on top — this is better than Dataverse virtual tables, which lose row-level security. Keep it. | Exists |
| Elastic tables | Skip. MySQL handles a manufacturer's volume; for sensor/log data use partitioned MySQL tables and a TTL purge job. | — |

### Business rules and server events

Replace business rules and plug-ins with one **table events** mechanism:

```
ab_table_events(id, table_id, event: 'beforeCreate'|'beforeUpdate'|'beforeDelete'|'afterCreate'|'afterUpdate'|'afterDelete',
                condition_fx, actions_json, run_mode: 'sync'|'async', order_no, enabled)
```

- **before** events run inside the write transaction in `DataService` after validation and before the SQL: they can set values, reject with a message (our "show error"), or require fields conditionally. These are the 80% of business rules that matter on the server.
- **after** sync events run in the same transaction (keep them small); **after async** events enqueue into the flow engine's job table (see `power-automate.md`).
- Conditions and value expressions are Fx formulas evaluated server-side with `ThisRecord`, `Old` (previous values) and `User()`.
- UI-only rules (show/hide, lock) stay where they belong: control properties in the canvas app (`Visible`, `DisplayMode`). Don't make a second rules system for UI.

This requires the server-side Fx evaluator. The engine is already DOM-free TypeScript (`src/fx`), so the server can import it as a runtime module; architecture.md rule 3 (server never imports client code at run time) would need an explicit exception for `src/fx`, or moving `src/fx` to a shared package. *This is the single most important architectural decision implied by this research.*

### API

Keep `/api/v1/data/:table/query` (structured JSON query), which is easier to secure than OData URL parsing. Add:

- Cursor paging: `{ top, after: <opaque cursor of last (orderKey, id)> }` with `nextCursor` in the response, ordering always tie-broken by `id`. This removes the 5,000-row cap (D10) for both delegation and API clients.
- `count: true` with an exact count (MySQL can count 1M rows of an indexed table quickly; cap at a timeout, not a fixed number).
- `aggregate: { groupBy, measures }` for charts and dashboards.
- Change feed: add `modified_on` index (exists as system column) and a `ab_deletions(table_id, row_id, deleted_on)` tombstone table; `GET /data/:table/changes?since=<token>` returns upserts and deletes. Simple and enough for sync to Tally agents or offline clients.
- Optional OData read-only adapter later, only for Excel/Power BI users (`/odata/v4/...`), mapped onto the same query service so security is identical.

### Audit and retention

- `ab_audit` already records writes. Add `old_values` / `new_values` JSON (only changed columns) for tables marked "audit changes", plus `env_id` and `category`. Per-table audit switch in `TableDef.audit: boolean`; default on for new tables (small orgs want history, data volume is low).
- Audit retention: one setting (days, default 730) and a nightly purge.
- Archiving: an "Archive" action per table = move rows matching a saved filter into `<table>__archive` with the same schema in the same database, read-only through the same API with `archived: true`, and **reversible**. Implemented as `INSERT ... SELECT` + `DELETE` in one transaction. No data lake.

### Search

MySQL `FULLTEXT` indexes on columns marked searchable, plus a global search endpoint `GET /api/v1/search?q=` that unions per-table queries **with the caller's row predicate applied**. Good enough for 20-50 users and a few hundred thousand rows. Also the base for RAG keyword retrieval (see `copilot-studio.md`).

## Where we can be better for a 20-50 person org

| Microsoft pain point | Evidence | Better design |
|---|---|---|
| Ownership type is chosen once and cannot change; wrong choice means delete and recreate the table | [Types of tables](https://learn.microsoft.com/power-apps/maker/data-platform/types-of-entities#table-ownership) | Every table has an `owner` column; scopes decide whether it matters. Nothing irreversible at create time. |
| "Business required" not enforced on API writes | [Create columns](https://learn.microsoft.com/power-apps/maker/data-platform/create-edit-field-portal#searching-and-sorting-columns) | Required means required, everywhere (already true in `data.ts`). |
| Three computed-column systems with different null rules; rollups wait 12 hours | [Rollup](https://learn.microsoft.com/power-apps/maker/data-platform/define-rollup-fields#rollup-calculations), [formula](https://learn.microsoft.com/power-apps/maker/data-platform/formula-columns#guidelines-and-limitations) | One formula column type in our Fx; rollups updated in the write transaction. |
| Business rules partly work in canvas apps, partly only in model-driven forms; logic split across business rules, classic workflows, plug-ins, low-code plug-ins (preview), functions (preview), flows | [Business rules](https://learn.microsoft.com/power-apps/maker/data-platform/data-platform-create-business-rule), [low-code plug-ins](https://learn.microsoft.com/power-apps/maker/data-platform/low-code-plug-ins) | One server-side table-events mechanism + flows for async. Same Fx everywhere. |
| Security has five interacting mechanisms (BU access levels, teams, sharing, hierarchy, column profiles) and needs a hidden settings tool to answer "who can see this row" | [How access is determined](https://learn.microsoft.com/power-platform/admin/how-record-access-determined#access-check) | Roles with scopes + row filters + column access, all on one screen per role; add teams and sharing later. Ship a **"Why can X see this row?"** explainer and a "view as user" preview from day one — cheap for us because the predicate is built in one place (`security.ts`). |
| Column security defaults to admin-only once enabled, in a separate profile object | [Column-level security](https://learn.microsoft.com/power-platform/admin/field-level-security) | Column access lives inside the role; you see it where you set table access. |
| Virtual tables lose row-level security, auditing, search | [Virtual table limits](https://learn.microsoft.com/power-apps/developer/data-platform/virtual-entities/get-started-ve#limitations-of-virtual-tables) | Our connector tables get the same RBAC/RLS/CLS (already true); add auditing on writes too. |
| 5,000-row page/count caps, no `$skip`, 24-hour-stale counts | [Page results](https://learn.microsoft.com/power-apps/developer/data-platform/webapi/query/page-results), [count rows](https://learn.microsoft.com/power-apps/developer/data-platform/webapi/query/count-rows) | Exact counts and cursor paging; the database is local and small. |
| Long-term retention is one-way, takes 72-96 hours, consumes API quota | [LTR](https://learn.microsoft.com/power-apps/maker/data-platform/data-retention-set#setup-a-retention-policy) | Reversible archive tables in the same MySQL. |
| Audit, files and search indexes billed as separate capacity pools | [Storage management](https://learn.microsoft.com/power-platform/admin/storage-management#how-your-data-grows-over-time) | It's the customer's disk; show usage, don't meter it. |

**Not worth replicating**: elastic tables, activity-party/multi-value party lists, currency with exchange rates (a manufacturer needs INR plus occasionally USD on an invoice — a currency code column is enough), Parent:Child BU depth, position hierarchy, access team templates, per-record column sharing, prompt columns as a column type (do AI in flows), FetchXML, the PreValidation/PreOperation/MainOperation/PostOperation numbering (two stages, before and after, suffice).

**Worth copying carefully**: privilege vs access check separation (privilege on the table first, then row predicate — we already do this), cumulative roles, cascade options on lookups, change tracking with a delta token, audit retention stamped per row, alternate keys for upsert.

## Sources

- [Types of tables](https://learn.microsoft.com/power-apps/maker/data-platform/types-of-entities)
- [Table definitions in Dataverse](https://learn.microsoft.com/power-apps/developer/data-platform/entity-metadata)
- [Create and edit elastic tables](https://learn.microsoft.com/power-apps/maker/data-platform/create-edit-elastic-tables)
- [Get started with virtual tables](https://learn.microsoft.com/power-apps/developer/data-platform/virtual-entities/get-started-ve)
- [Types of columns](https://learn.microsoft.com/power-apps/maker/data-platform/types-of-fields)
- [Create and edit columns](https://learn.microsoft.com/power-apps/maker/data-platform/create-edit-field-portal)
- [Image column data](https://learn.microsoft.com/power-apps/developer/data-platform/image-column-data)
- [Define rollup columns](https://learn.microsoft.com/power-apps/maker/data-platform/define-rollup-fields)
- [Specialized columns using code](https://learn.microsoft.com/power-apps/developer/data-platform/specialized-columns)
- [Work with formula columns](https://learn.microsoft.com/power-apps/maker/data-platform/formula-columns)
- [Table relationships](https://learn.microsoft.com/power-apps/maker/data-platform/create-edit-entity-relationships)
- [Work with alternate keys](https://learn.microsoft.com/power-apps/developer/data-platform/define-alternate-keys-entity)
- [Create a business rule for a table](https://learn.microsoft.com/power-apps/maker/data-platform/data-platform-create-business-rule)
- [Business rules in model-driven forms](https://learn.microsoft.com/power-apps/maker/model-driven-apps/create-business-rules-recommendations-apply-logic-form)
- [Security roles and privileges](https://learn.microsoft.com/power-platform/admin/security-roles-privileges)
- [Ownership-based security](https://learn.microsoft.com/power-platform/admin/wp-security-cds)
- [How access to a record is determined](https://learn.microsoft.com/power-platform/admin/how-record-access-determined)
- [Column-level security](https://learn.microsoft.com/power-platform/admin/field-level-security)
- [Column-level security by using code](https://learn.microsoft.com/power-apps/developer/data-platform/column-level-security)
- [Hierarchy security](https://learn.microsoft.com/power-platform/admin/hierarchy-security)
- [Team types (Sustainability security guide)](https://learn.microsoft.com/dynamics365/sustainability/well-architected/sustainability-hierarchical-security)
- [Access controls for Dataverse](https://learn.microsoft.com/azure/azure-sovereign-clouds/public/access-controls-dataverse-power-platform)
- [Event framework](https://learn.microsoft.com/power-apps/developer/data-platform/event-framework)
- [Register a plug-in](https://learn.microsoft.com/power-apps/developer/data-platform/register-plug-in)
- [Handle exceptions in plug-ins](https://learn.microsoft.com/power-apps/developer/data-platform/handle-exceptions)
- [Scalable customization design: database transactions](https://learn.microsoft.com/power-apps/developer/data-platform/scalable-customization-design/database-transactions)
- [Low-code plug-ins (preview)](https://learn.microsoft.com/power-apps/maker/data-platform/low-code-plug-ins)
- [Functions in Dataverse (preview)](https://learn.microsoft.com/power-apps/maker/data-platform/functions-overview)
- [Query data using OData](https://learn.microsoft.com/power-apps/developer/data-platform/webapi/query/overview)
- [Page results](https://learn.microsoft.com/power-apps/developer/data-platform/webapi/query/page-results)
- [Count rows](https://learn.microsoft.com/power-apps/developer/data-platform/webapi/query/count-rows)
- [Change tracking](https://learn.microsoft.com/power-apps/developer/data-platform/use-change-tracking-synchronize-data-external-systems)
- [Manage Dataverse auditing](https://learn.microsoft.com/power-platform/admin/manage-dataverse-auditing)
- [Configure auditing (developer)](https://learn.microsoft.com/power-apps/developer/data-platform/auditing/configure)
- [Long-term data retention overview](https://learn.microsoft.com/power-apps/maker/data-platform/data-retention-overview)
- [Set a data retention policy](https://learn.microsoft.com/power-apps/maker/data-platform/data-retention-set)
- [Long-term data retention (developer)](https://learn.microsoft.com/power-apps/developer/data-platform/long-term-retention)
- [Storage management](https://learn.microsoft.com/power-platform/admin/storage-management)
