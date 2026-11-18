# Power Pages

Research date: 18 November 2026. Sources are Microsoft Learn pages retrieved on that date, plus news coverage of a 2024 security research report (marked as secondary). Opinions are labelled *inference*; unconfirmed claims are labelled *unverified*.

Power Pages (formerly Power Apps portals, before that Adxstudio) builds external-facing websites over Dataverse. Appbuilder plans a similar external site builder, so this file covers the architecture, the security model and the ways it goes wrong.

## 1. Architecture: a site is Dataverse metadata rendered by a hosted web app

- A site's configuration — web pages, page templates, web templates, content snippets, site settings, web roles, table permissions, column permissions, lists, forms, multistep forms and steps, redirects, web files, web links, site markers — is stored as **Dataverse records**.
- Two storage models: the **standard data model** keeps each component type in its own custom table (`adx_webpage`, `adx_webtemplate`, `adx_entitypermission`, ...); the **enhanced data model** (default for new sites) stores them in system tables `powerpagesite`, `powerpagesitelanguage` and one generic `powerpagecomponent`, exposed through virtual tables (`mspp_webpage`, ...). Microsoft says the standard model was slower to provision and needed manual package updates ([enhanced data model](https://learn.microsoft.com/power-pages/admin/enhanced-data-model), [server-side caching table list](https://learn.microsoft.com/power-pages/admin/clear-server-side-cache)).
- The site runtime is a Microsoft-hosted web application (ASP.NET based; its identity layer is ASP.NET Identity per [authentication overview](https://learn.microsoft.com/power-pages/security/authentication/)) that reads this metadata, renders pages server-side and queries business data from Dataverse.
- Microsoft points to an architecture white paper for scaling, availability and CDN/WAF details ([security overview](https://learn.microsoft.com/power-pages/security/power-pages-security#page-permissions)); the paper wasn't fetched, so hosting specifics beyond this are *unverified*.

### Content model

| Concept | What it is |
|---|---|
| Web page | A node in the site map with a URL, parent page, title, **Copy** (rich content that can contain Liquid), page template |
| Page template | Chooses how a page renders; usually points at a **web template** |
| Web template | A record holding source text, typically **Liquid** + HTML, with optional MIME type; can include or extend other templates by name; used for full layouts, headers, footers ([web templates](https://learn.microsoft.com/power-pages/configure/web-templates)) |
| Content snippet | Named reusable text/HTML, referenced from Liquid |
| Site settings | Name/value configuration records (authentication options, behaviours) |
| Web files | Static files (CSS, JS, images) stored as records with attachments |

### Liquid

Liquid is an open-source template language processed **server-side**, outputting plain HTML ([Liquid overview](https://learn.microsoft.com/power-pages/configure/liquid/liquid-overview)). Power Pages adds objects — `page`, `user` (the signed-in contact), `request`/`params`, `settings`, `snippets`, `sitemap`, `weblinks`, `website`, `entities` (load any Dataverse row by id), `now` (cached, not refreshed per render) ([Liquid objects](https://learn.microsoft.com/power-pages/configure/liquid/liquid-objects)) — and Dataverse tags such as `fetchxml` (run a FetchXML query), `entitylist`, `entityview`, `chart` (embed a model-driven chart by id) ([Dataverse Liquid tags](https://learn.microsoft.com/power-pages/configure/liquid/dataverse-liquid-tags)). Lookups come back as reference objects, choices as option objects, and related rows can be traversed by relationship name; Microsoft warns that loading related rows in loops hurts rendering performance.

## 2. Data components

| Component | Behaviour |
|---|---|
| **List** (entity list) | Renders a Dataverse view as a paginated, sortable, searchable table; optional view selector; record actions (view, edit, delete) shown per row according to table permissions when `EntityList/ShowRecordLevelActions` is on ([securing lists](https://learn.microsoft.com/power-pages/configure/securing-lists)) |
| **Form** (basic form) | Renders a Dataverse main form in insert, edit or read-only mode |
| **Multistep form** (formerly advanced form) | A chain of steps, each a form on some table, with conditional branching; next-step pointers, terminal steps, progress indicator, captcha for anonymous/authenticated users, "multiple entries per person", redirect on submit; step history stored in a session table — after editing steps Microsoft recommends deleting all session records ([add multistep form](https://learn.microsoft.com/power-pages/getting-started/multistep-forms#create-new-multistep-form), [steps](https://learn.microsoft.com/power-pages/configure/multistep-form-steps)). Some properties still need the Portal Management app. |
| **Web API** | A REST API on the site for client-side JavaScript to read/write Dataverse, enabled per table with an explicit column allowlist ([security best practices](https://learn.microsoft.com/power-pages/security/security-best-practices#authorization-for-pages,-data,-and-apis)) |

## 3. Users, authentication and identity providers

- External users are **Dataverse contact records**; email must be unique across contacts, including deactivated ones, or none of them can sign in ([authentication overview](https://learn.microsoft.com/power-pages/security/authentication/)).
- Providers: **OpenID Connect** (Microsoft Entra ID, multitenant Entra ID, **Microsoft Entra External ID** — Microsoft's CIAM, sharing technology with Azure AD B2C but a distinct service — Azure AD B2C, or any OIDC provider), **SAML 2.0**, **WS-Federation**, and OAuth 2.0 social providers (Microsoft, LinkedIn, Facebook, Google, Twitter; one instance of each) ([provider table](https://learn.microsoft.com/power-pages/security/authentication/#common-identity-providers), [Entra External ID](https://learn.microsoft.com/power-pages/security/authentication/entra-external-id)).
- OIDC flows: implicit grant is the default; authorization code with `client_secret_post` or `private_key_jwt`; hybrid only with `id_token` ([OIDC provider](https://learn.microsoft.com/power-pages/security/authentication/openid-provider)).
- **Local authentication** (username/password stored on the contact) exists but Microsoft says "not recommended" and to disable local sign-in providers ([planning](https://learn.microsoft.com/power-pages/configure/planning-power-pages-project#access)).
- Internal users should sign in with Entra ID, which every site has preconfigured.
- Authentication setting changes can take minutes to apply; restart the site to apply immediately ([site authentication](https://learn.microsoft.com/power-pages/security/authentication/configure-site)).
- **Site visibility**: new sites are private (Entra sign-in for internal users only) until switched to public ([security overview](https://learn.microsoft.com/power-pages/security/power-pages-security)).

## 4. Authorization model

| Layer | Purpose |
|---|---|
| **Web roles** | Groups of contacts. Two special roles: **Authenticated Users** (every signed-in contact gets it automatically) and **Anonymous Users** (every visitor; respects only table permissions). One of each per site ([web roles](https://learn.microsoft.com/power-pages/security/create-web-roles)) |
| **Page permissions** | Restrict a page (and children) to web roles. Hiding a page from navigation doesn't secure it |
| **Table permissions** | Grant web roles Read/Write/Create/Delete/Append/Append To on a table with an **access type** |
| **Column permissions** | Power Pages column permission profiles for the Web API; with "enhanced authorization", Dataverse column security profiles instead |
| **Website access permissions** | Admin-type rights on the site itself (e.g. using `/_services/about` cache tools) |

**Access types** for table permissions ([table permissions](https://learn.microsoft.com/power-pages/security/table-permissions#available-access-types)):

| Access type | Rows covered |
|---|---|
| Global | All rows in the table |
| Contact | Rows related to the signed-in contact through a relationship |
| Account | Rows related to the signed-in contact's account (parent customer) |
| Self | Only the contact's own contact row |
| Parent | Child permission: rows related to rows the parent permission grants (Portal Management app only; in studio you add child permissions) |
| Custom (preview, enhanced authorization) | Rows matching a FetchXML **filter** element |

Since release 9.3.7.x, new sites enforce table permissions on all lists regardless of the old "Enable Table Permissions" switch ([securing lists](https://learn.microsoft.com/power-pages/configure/securing-lists)).

Microsoft's [security best practices](https://learn.microsoft.com/power-pages/security/security-best-practices#authorization-for-pages,-data,-and-apis) now explicitly say: treat anonymous permissions as public data; avoid Global access for sensitive data, especially when the table is exposed through the Web API; enable the Web API only for required tables with explicit column allowlists; don't rely on client-side filtering; and don't assume Web API column permissions protect data exposed through search, Liquid, FetchXML, forms or lists.

### What goes wrong in practice (secondary sources)

In November 2024 AppOmni's research, reported by [The Register](https://www.theregister.com/2024/11/15/microsoft_power_pages_misconfigurations/) and [TechRepublic](https://www.techrepublic.com/article/uk-nhs-employee-records-exposed/), found Power Pages sites leaking millions of records. The reported pattern: open registration turns anyone into an "Authenticated User"; that role (or Anonymous) got **Global** table permissions; the Web API exposed all columns; column security was rarely configured. One shared-services provider for the UK NHS exposed data on over 1.1 million employees (since fixed). *These are news reports of third-party research, not Microsoft documentation.* Microsoft's current best-practice page reads like a direct response.

## 5. Caching

From [server-side caching](https://learn.microsoft.com/power-pages/admin/clear-server-side-cache):

- **Configuration tables** (pages, templates, snippets, permissions, settings...) are cached for all users; changes made in Dataverse propagate with an SLA of **15 minutes**.
- **Business data** is cached per user (shared for anonymous users and Global-permission tables), only for data actually accessed. A create/update/delete made **through the website** clears that table's cache for all users instantly; changes made elsewhere (model-driven apps, flows, plug-ins) appear **within 15 minutes**, and Microsoft says immediate reflection of plug-in/workflow side effects "is never guaranteed". The 15 minutes can't be shortened.
- Manual clearing: Preview in design studio, or `/_services/about` (requires a web role with all website access permissions) — but clearing during peak hours can slow the site.

*Inference*: this is the single most surprising behaviour for a business that updates prices or stock from an internal app and expects the website to show it.

## 6. Design studio and tooling

The **design studio** has workspaces: Pages (WYSIWYG sections and components), Styling (themes), Data (create tables, views, forms in Dataverse), Set up (authentication, settings), and **Security** (run scan, web roles, page permissions, table permissions, web application firewall, identity providers, site visibility, HTTP headers) ([security workspace](https://learn.microsoft.com/power-pages/getting-started/use-security-workspace)). Advanced configuration still drops into the **Portal Management app**, a model-driven app over the metadata tables; new web roles created there need a "Sync" and a browser refresh before the studio sees them ([display data securely tutorial](https://learn.microsoft.com/power-pages/getting-started/tutorial-display-data-securely#set-access-type-and-privileges)). Pro developers use VS Code with the Power Platform CLI to download/upload site metadata (*unverified* detail; not on a fetched page).

**Security scan**: a "deep scan" of anonymous pages (optionally authenticated pages using the maker's credentials) for issues such as XSS and insecure libraries; results by email and a PDF report; English-US only ([security scan](https://learn.microsoft.com/power-pages/security/security-scan), [security overview](https://learn.microsoft.com/power-pages/security/power-pages-security#page-permissions)). Sites can sit behind Azure Front Door as a WAF.

## 7. Licensing (concept)

Capacity based, per website per month: **authenticated users** (unique contacts who sign in during a calendar month) and **anonymous users** (unique anonymous cookie ids that visit anonymous pages), each as prepaid capacity or pay-as-you-go meters. Clearing cookies or switching browsers counts as a new anonymous user ([Power Pages licensing FAQ](https://learn.microsoft.com/power-platform/admin/powerapps-flow-licensing-faq#power-pages)). Prices weren't on the fetched page (*unverified*).

## 8. Known pain points (summary)

| Pain point | Evidence |
|---|---|
| Two security systems to reason about (internal Dataverse roles vs external web roles and table permissions with different access types) | [Table permissions](https://learn.microsoft.com/power-pages/security/table-permissions#available-access-types) |
| Easy to publish data publicly by granting Global access to Anonymous/Authenticated roles; real-world leaks | [Best practices](https://learn.microsoft.com/power-pages/security/security-best-practices#authorization-for-pages,-data,-and-apis); news: [The Register](https://www.theregister.com/2024/11/15/microsoft_power_pages_misconfigurations/) |
| 15-minute cache for changes made outside the site | [Caching](https://learn.microsoft.com/power-pages/admin/clear-server-side-cache) |
| Configuration split between design studio and Portal Management app | [Multistep forms](https://learn.microsoft.com/power-pages/getting-started/multistep-forms), [web roles](https://learn.microsoft.com/power-pages/security/create-web-roles) |
| Two data models (standard vs enhanced) in the field | [Enhanced data model](https://learn.microsoft.com/power-pages/admin/enhanced-data-model) |
| Liquid + FetchXML for anything custom: two more languages beyond Power Fx | [Dataverse Liquid tags](https://learn.microsoft.com/power-pages/configure/liquid/dataverse-liquid-tags) |
| Contact email uniqueness includes deactivated contacts | [Authentication overview](https://learn.microsoft.com/power-pages/security/authentication/) |
| Anonymous user counting by cookie makes cost unpredictable | [Licensing FAQ](https://learn.microsoft.com/power-platform/admin/powerapps-flow-licensing-faq#power-pages) |

## How to replicate on our stack (single Node server + MySQL)

### Deployment reality first

Our default install is a PC on a plant LAN. A public site needs a public address. Options, in order of preference for the pilot:

1. **VPS install** of Appbuilder (the second supported deployment) hosts the site directly behind Caddy/nginx with automatic TLS.
2. **On-prem server + outbound tunnel** (for example a Cloudflare Tunnel or similar reverse tunnel) exposing only the `/site/*` routes, never `/api/v1` admin routes.
3. **Static export** for pure content sites (no forms) pushed to any static host.

The site router must run on a **separate listener/port or host name** from the internal portal so a reverse proxy can expose one without the other. The router already checks Host and Origin (`APPBUILDER_ALLOWED_HOSTS`), so a site gets its own allowed host.

### Data model

```sql
ab_sites(id, env_id, name, host_names JSON, visibility ENUM('private','public'), theme JSON, settings JSON, published_version)
ab_site_versions(site_id, version, definition LONGTEXT, published_by, published_on)   -- pages, layout, nav as JSON
ab_site_users(id, site_id, email, name, password_hash NULL, status, email_verified_on, created_on, last_login, contact_row_id NULL)
ab_site_user_identities(site_user_id, provider, subject)          -- OIDC/Google sign-ins
ab_site_roles(id, site_id, name, is_default_authenticated, is_anonymous)
ab_site_user_roles(site_user_id, site_role_id)
ab_site_table_access(site_role_id, table_id, can_read, can_create, can_update, can_delete,
                     scope ENUM('mine','my_org','related','all'), relation JSON, columns JSON, row_filter JSON)
ab_site_sessions(...)                                              -- separate from internal ab_sessions
```

Mapping to Power Pages:

| Power Pages | Ours |
|---|---|
| Contact | `ab_site_users`, optionally linked to a row in a business table (`contact_row_id`, for example a row in `Customers`) |
| Account | "my organisation" = the linked row's lookup to a company table, configured per site (`settings.orgLookup`) |
| Web role | `ab_site_roles` |
| Table permission + access type | `ab_site_table_access`: `mine` (rows whose designated owner column = me), `my_org`, `related` (via a lookup path), `all`; plus `row_filter` using our existing `RowCondition` (equivalent to their Custom/FetchXML type) and `columns` allowlist |
| Page permission | `page.access: { roles: [...] }` in the site definition |
| Web template + Liquid | Pages built from **blocks** (hero, rich text, image, list, form, multistep form, card grid, map, embed) in JSON; optional custom HTML block with a small, sandboxed template syntax (Mustache-like, logic-less) — no general template language |
| List | `list` block bound to a table + view (`RowCondition[]`), columns, page size, search, row actions |
| Form / multistep form | `form` block bound to a table; `wizard` block = ordered steps each with fields, optional condition Fx for branching; drafts stored in `ab_site_drafts` keyed by session |
| Web API | Not exposed by default. Blocks call **site-scoped endpoints** (`/site/:siteId/api/blocks/:blockId/...`) that can only do what that block is configured to do (the columns it shows, the operation it performs). No generic table API for anonymous users. |

### Enforcement

- The site's data path reuses `DataService` with a **site principal**: the predicate is built from `ab_site_table_access` exactly like internal RLS (`security.ts` builds a row predicate; add a second builder for site principals). Column allowlists are the intersection of the block's columns and the role's `columns`.
- **Default deny**, and anonymous/`all` grants require an explicit confirmation step in the UI ("This makes every row of *Orders* public on the internet. Type ORDERS to confirm"). A **publish-time security lint** fails publishing when: anonymous role has `all` on a table with any column marked sensitive; a form allows update without `mine`/`my_org` scope; open registration is on and the default authenticated role has `all` read on a non-public table. This directly addresses the misconfiguration pattern in the 2024 reports.
- Rate limits and captcha (self-hosted proof-of-work or hCaptcha/Turnstile via connector) on registration, sign-in and anonymous form submissions; per-IP and per-account throttles (the internal auth throttle exists).
- Security headers by default (CSP with nonces, HSTS when TLS, X-Content-Type-Options, frame-ancestors none unless embedding is enabled).

### Rendering and caching

- Server-side render pages to HTML (good for SEO and slow phones). Since the server has no build step and runs TypeScript directly, use a small HTML renderer for blocks in plain TypeScript (string templates with escaping) rather than server-side React; hydrate interactive blocks (forms, lists with paging) with a small client bundle built by Vite alongside `dist/index.html`.
- Caching: published site definitions in memory (invalidated on publish — instant, single process). Data: cache anonymous `all`-scope list results for N seconds (default 30) keyed by query; **invalidate on any write to that table through DataService** (we see every write, including from internal apps and flows, so there's no 15-minute lag). Per-user data isn't cached.

### Authentication

- Local email + password (scrypt, already used internally) with email verification and password reset via SMTP; this is the right default for Indian SMEs whose customers won't have Entra accounts. Add **OTP sign-in by email or WhatsApp/SMS** (very common in India) as a first-class provider.
- OIDC generic provider (Google, Microsoft, any OIDC) with authorization code + PKCE. Skip SAML/WS-Fed until a customer asks.
- Invitation codes (an internal user invites a customer contact; the code links the site user to a `Customers` row) — Power Pages has invitations too (*unverified*; not on a fetched page), and it's the safest onboarding for B2B portals (dealer/vendor portals for a manufacturer).

### Design studio

Reuse the Studio shell: page tree, block palette, properties panel, theme editor, "Security" tab showing per-role effective access as a matrix (role × table × operation × scope) with the lint results, and a "View as..." preview for anonymous / any role. Publishing creates a new `ab_site_versions` row; rollback = publish an older version.

### Licensing

Don't meter external users. Price per site (or include one site per install).

## Where we can be better for a 20-50 person org

| Microsoft pain point | Better design |
|---|---|
| Global access + open registration leaking data ([best practices](https://learn.microsoft.com/power-pages/security/security-best-practices#authorization-for-pages,-data,-and-apis); [news](https://www.theregister.com/2024/11/15/microsoft_power_pages_misconfigurations/)) | Default deny, block-scoped endpoints instead of a generic Web API, typed confirmation for public grants, publish-time lint |
| 15-minute cache SLA for external changes ([caching](https://learn.microsoft.com/power-pages/admin/clear-server-side-cache)) | Write-through invalidation; one process sees all writes |
| Studio + Portal Management app split | One studio |
| Liquid + FetchXML + JavaScript + Web API for customisation | Blocks + our Fx for conditions; logic-less custom HTML only |
| Contacts as users, email uniqueness across deactivated rows | Site users table, linkable to any business row |
| Per-user/per-cookie metering | Flat price |
| Local auth "not recommended", pushing an Entra External ID setup | Local + email/WhatsApp OTP built in, OIDC optional |

**Not worth replicating**: two data models, web templates with template inheritance, content snippets/site markers/web link sets as separate record types (fold into the site JSON), WS-Federation and SAML, polls, forums/blogs (*Power Pages starter templates have these; unverified for current templates*), multilingual site records per language at first (add a `translations` map per block later), the `/_services/about` cache tools.

**Worth copying**: role-based table access with relationship scopes (mine / my org / related / all), page-level permissions, list/form/multistep blocks bound to tables, captcha on anonymous forms, private-by-default site visibility, a built-in security scan concept (our lint + header checks), explicit column allowlists.

**Typical pilot use**: a dealer/vendor portal (order status, dispatch tracking, invoice download, complaint/NCR submission) for the manufacturer — authenticated B2B users, `my_org` scope, a handful of pages. Build for that, not for marketing websites.

## Sources

- [Enhanced data model](https://learn.microsoft.com/power-pages/admin/enhanced-data-model)
- [How server-side caching works](https://learn.microsoft.com/power-pages/admin/clear-server-side-cache)
- [Web templates](https://learn.microsoft.com/power-pages/configure/web-templates)
- [Liquid overview](https://learn.microsoft.com/power-pages/configure/liquid/liquid-overview)
- [Available Liquid objects](https://learn.microsoft.com/power-pages/configure/liquid/liquid-objects)
- [Dataverse Liquid tags](https://learn.microsoft.com/power-pages/configure/liquid/dataverse-liquid-tags)
- [Securing lists](https://learn.microsoft.com/power-pages/configure/securing-lists)
- [Add a multistep form](https://learn.microsoft.com/power-pages/getting-started/multistep-forms)
- [Define multistep form steps](https://learn.microsoft.com/power-pages/configure/multistep-form-steps)
- [Overview of authentication](https://learn.microsoft.com/power-pages/security/authentication/)
- [Set up site authentication](https://learn.microsoft.com/power-pages/security/authentication/configure-site)
- [Set up an OpenID Connect provider](https://learn.microsoft.com/power-pages/security/authentication/openid-provider)
- [Set up Microsoft Entra External ID](https://learn.microsoft.com/power-pages/security/authentication/entra-external-id)
- [Plan your Power Pages project](https://learn.microsoft.com/power-pages/configure/planning-power-pages-project)
- [Power Pages security](https://learn.microsoft.com/power-pages/security/power-pages-security)
- [Security best practices](https://learn.microsoft.com/power-pages/security/security-best-practices)
- [Create and assign web roles](https://learn.microsoft.com/power-pages/security/create-web-roles)
- [Configuring table permissions](https://learn.microsoft.com/power-pages/security/table-permissions)
- [Assign table permissions](https://learn.microsoft.com/power-pages/security/assign-table-permissions)
- [Tutorial: Display data securely](https://learn.microsoft.com/power-pages/getting-started/tutorial-display-data-securely)
- [Security workspace](https://learn.microsoft.com/power-pages/getting-started/use-security-workspace)
- [Run security scan](https://learn.microsoft.com/power-pages/security/security-scan)
- [Power Platform licensing FAQ (Power Pages)](https://learn.microsoft.com/power-platform/admin/powerapps-flow-licensing-faq#power-pages)
- News (secondary): [The Register, 15 Nov 2024](https://www.theregister.com/2024/11/15/microsoft_power_pages_misconfigurations/); [TechRepublic](https://www.techrepublic.com/article/uk-nhs-employee-records-exposed/)
