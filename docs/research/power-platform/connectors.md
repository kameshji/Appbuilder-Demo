# Connectors

Research date: 18 November 2026. Sources are Microsoft Learn pages retrieved on that date. Opinions are labelled *inference*; unconfirmed claims are labelled *unverified*.

## 1. What a connector is

Microsoft defines a connector as a proxy or wrapper around an API that lets the service talk to Power Automate, Power Apps and Logic Apps, offering prebuilt actions and triggers; a **connection** is a stored authentication credential for one connector; a **connection reference** is a solution component that points at a connection so apps and flows bind to the reference, not the credential ([connection references](https://learn.microsoft.com/power-apps/maker/data-platform/create-connection-reference)).

Every connector is described by an **OpenAPI** document. Each action maps directly to an operation in that specification; triggers are polling or push ([connector architecture](https://learn.microsoft.com/connectors/connector-architecture)). Custom connectors must use **OpenAPI 2.0 (Swagger)** — OpenAPI 3.0 isn't supported — and the definition must be under 1 MB; only ASCII header names and values are allowed ([create from OpenAPI](https://learn.microsoft.com/connectors/custom-connectors/define-openapi-definition#prerequisites)). Connector-specific behaviours (dynamic dropdowns, dynamic schemas, visibility, trigger types) are encoded as `x-ms-*` vendor extensions in the Swagger (*unverified* in detail; the extension list wasn't on a fetched page).

A canvas app connector can expose **tables** (tabular: SharePoint, SQL, Excel, Dataverse) or **actions** (Office 365 Outlook, Translator) or both ([connectors for canvas apps](https://learn.microsoft.com/power-apps/maker/canvas-apps/connections-list)). Power Apps itself doesn't support triggers; it starts flows instead ([architecture](https://learn.microsoft.com/connectors/connector-architecture)). Microsoft recommends no more than 10 connectors and 20 connection references per canvas app for load time.

## 2. Runtime architecture ("API hub")

From [Connectors architecture](https://learn.microsoft.com/connectors/connector-architecture):

| Component | Role |
|---|---|
| Credential and metadata store | Holds connector metadata (Swagger), connection records, ACLs on connections, and the encrypted credentials |
| Azure API Management (APIM) | Hosts every connector's Swagger and policies; the entry point for all connector calls; validates keys, tokens and certificates |
| App Service Environment | Hosts the connector web apps that translate calls into the target API |
| On-premises data gateway | Bridges to private networks (below) |

So a call from a canvas app to SharePoint goes browser → APIM (connector endpoint, with a connection id) → connector web app → SharePoint, with the stored token injected server-side. The commonly used name "API hub" for this layer is *unverified* on fetched pages. Dataverse is the exception: canvas app calls to Dataverse go directly to the environment, not through APIM, which is why Microsoft says it tends to be faster ([performance considerations](https://learn.microsoft.com/power-apps/maker/canvas-apps/app-performance-considerations#specific-data-sources)).

## 3. Standard, premium, custom

| Class | Licensing | Examples |
|---|---|---|
| Standard | Included with Microsoft 365 / seeded rights; "don't require special licensing" ([connectors list](https://learn.microsoft.com/power-apps/maker/canvas-apps/connections-list#popular-connectors)) | SharePoint, Outlook, Teams, OneDrive, Excel Online |
| Premium | Requires a premium Power Apps / Power Automate licence for every user who runs the app or flow | Dataverse (outside Teams), SQL Server, HTTP, Salesforce, most line-of-business systems, on-premises gateway use (*premium status per connector is listed on each connector page; not individually verified here*) |
| Custom | Treated as premium: "you must have a premium or trial license to run any flow that uses a custom connector"; 50 per user; 500 requests/min per connection ([limits](https://learn.microsoft.com/power-automate/limits-and-config#request-limits)) | Your own REST API |
| Certified | A custom connector submitted to Microsoft and published to all tenants after review, by a verified or independent publisher ([certification](https://learn.microsoft.com/connectors/custom-connectors/submit-certification)) | Partner connectors |

Custom connector lifecycle: build API → secure it → describe it (OpenAPI import, Postman collection, or from blank) → test → share within the org → optionally certify ([custom connectors overview](https://learn.microsoft.com/connectors/custom-connectors/#lifecycle)). When the API definition changes, Microsoft's guidance is to republish the connector, remove the connection/data source from every app that uses it, and re-add it.

## 4. Authentication types

From the [custom connector overview](https://learn.microsoft.com/connectors/custom-connectors/#lifecycle) and [connectors for canvas apps](https://learn.microsoft.com/power-apps/maker/canvas-apps/connections-list#security-and-types-of-authentication):

| Type | Who the call runs as | Notes |
|---|---|---|
| Microsoft Entra ID (OAuth) | The signed-in end user | Secure: the back end enforces each user's rights |
| OAuth 2.0 (generic or service-specific: GitHub, Dropbox, Salesforce...) | Each user signs in with their own account | Secure. Since February 2024 each custom connector has its own redirect URI; older connectors had to be migrated ([overview](https://learn.microsoft.com/connectors/custom-connectors/#lifecycle)). Client-credentials grants are not supported in custom connector OAuth security definitions ([OpenAPI prerequisites](https://learn.microsoft.com/connectors/custom-connectors/define-openapi-definition#prerequisites)). |
| API key | A shared key | |
| Basic | A shared username/password | |
| Windows authentication | A shared Windows account through a gateway | Not secure per Microsoft: anyone with the connection reaches everything that account can |
| Anonymous | none | Gateway selection unsupported for anonymous custom connectors |

### Shared vs per-user connections

- With OAuth/Entra connectors, each user creates their own connection the first time they run the app (a consent dialog).
- With **shared** credentials (SQL authentication, API key, Windows), the maker's connection is **implicitly shared** with everyone the app is shared with. Before January 2024 users could reuse that connection to build their own apps against the same database. Since then, newly created shared connections are **secure implicit connections**: the app talks to a proxy connection that only allows the CRUD verbs the app uses for that data source; old apps had to be republished. Limitations: server and database names still appear in the consent dialog, column names aren't hidden, and a Put permission implies Post ([secure implicit connections](https://learn.microsoft.com/power-apps/maker/canvas-apps/connections-list#security-and-types-of-authentication), [share resources](https://learn.microsoft.com/power-apps/maker/canvas-apps/share-app-resources#connections)).
- Flows run with the connections of the flow (owner's by default), or "run-only users" provide their own.

*Inference*: the security of a canvas app that uses SQL authentication relied for years on obscurity of the connection. It's a cautionary tale for us: shared server credentials must never reach the browser, and the server must enforce row/column rules itself (which our D6 does).

## 5. Connections vs connection references

| | Connection | Connection reference |
|---|---|---|
| What | Credential instance for one connector, owned by a user, can be shared | Solution component naming "the SharePoint connection this solution needs" |
| Lives in | The environment | The solution, exported with it |
| On import | Not exported | Importer picks or creates a connection for each reference; flows can then be turned on automatically |
| Used by | Non-solution apps and flows directly | Solution flows (for all connectors); solution canvas apps only for implicitly shared (non-OAuth) connections ([connection references](https://learn.microsoft.com/power-apps/maker/data-platform/create-connection-reference#add-connection-references-to-a-solution)) |

Existing apps and flows are not automatically upgraded; to move a canvas app to a connection reference you remove the data source and add it again. Data-source **environment variables** complement references by holding non-credential parameters such as SharePoint site URL and list (see `admin-and-environments.md`).

## 6. On-premises data gateway

A Windows service installed on a machine inside the private network ([what is a gateway](https://learn.microsoft.com/data-integration/gateway/service-gateway-onprem), [Power Platform gateway](https://learn.microsoft.com/power-platform/admin/wp-onpremises-gateway)):

1. A cloud service builds a query plus the **encrypted** data source credentials and puts it on the gateway's queue in the gateway cloud service.
2. The gateway cloud service pushes the request through **Azure Service Bus / Azure Relay**.
3. The gateway, which holds only an **outbound** connection (TCP 443, optionally 5671-5672 and 9350-9354), receives it, **decrypts the credentials locally** (asymmetric encryption; private key on the gateway), queries the data source, and returns results the same way ([Logic Apps gateway flow](https://learn.microsoft.com/azure/logic-apps/install-on-premises-data-gateway-workflows#how-the-gateway-works), [ExpressRoute architecture](https://learn.microsoft.com/power-platform/architecture/key-concepts/expressroute/understanding-architecture#on-premises-data-gateway)).

Operational facts: no inbound ports; TLS 1.2; one gateway per server; runs as `NT Service\PBIEgwService` by default; a gateway serves environments in its own region only; updates monthly and are **not auto-installed**, and only the last six releases are supported; a **recovery key** chosen at install is needed to move or restore it; clusters provide HA ([gateway port usage](https://learn.microsoft.com/power-platform/admin/wp-onpremises-gateway#port-usage), [gateway overview](https://learn.microsoft.com/data-integration/gateway/service-gateway-onprem)). Gateway use requires most Power Apps/Automate licences except low-end Microsoft 365 business SKUs. Desktop flows no longer use gateways; they use direct machine connectivity over Azure Relay ([desktop architecture](https://learn.microsoft.com/power-automate/desktop-flows/pad-architecture)).

## 7. Throttling

Three layers:

1. **Connector limits** per connection, documented on each connector page — for example SharePoint 600 operations per minute per connection; custom connectors 500 requests/min per connection; violations return HTTP 429 "Rate limit is exceeded. Try again in N seconds" ([licensing FAQ](https://learn.microsoft.com/power-platform/admin/power-automate-licensing/faqs#action-limits-and-capacity-questions), [understand limits](https://learn.microsoft.com/power-automate/guidance/coding-guidelines/understand-limits#api-throughput-limits-on-connectors)).
2. **Dataverse service protection limits** per user (see `cross-cutting.md`).
3. **Power Platform request entitlements** per user or per flow per 24 hours (see `power-automate.md`).

## 8. How data policies group connectors

Data (DLP) policies put each connector into **Business**, **Non-Business** or **Blocked**; one app or flow may not mix Business with Non-Business; Microsoft-owned standard and core Dataverse connectors can't be blocked; custom connectors are classified by name per environment or by host URL pattern at tenant level; HTTP connectors are classifiable and blocking them can break child flows; enforcement happens at design time and run time ([policy strategy](https://learn.microsoft.com/power-platform/guidance/adoption/dlp-strategy#quick-facts), [classification](https://learn.microsoft.com/power-platform/admin/dlp-connector-classification)). Policies are connector-aware, not connection-aware. Newer **advanced connector policies** switch to default-deny allowlists down to individual actions, but only for certified connectors so far ([ACP](https://learn.microsoft.com/power-platform/admin/advanced-connector-policies)). Details are in `admin-and-environments.md`.

## How to replicate on our stack (single Node server + MySQL)

### What we have

`ab_connections(id, name, connector, settings, secret_sealed, status, is_default, scope)` and a `Connector` interface for **tabular** sources (`select/insert/update/delete/ddl`), with `DataService` enforcing security before the connector sees a query (docs/dev/connectors.md). Three tabular connectors: MySQL, files, Google Sheets. Connectors are compiled in; makers can't add them.

### What to add: two connector families behind one registry

| Family | Purpose | Interface |
|---|---|---|
| **Table connectors** (exists) | Rows that apps and the security engine treat as tables | Existing `Connector` |
| **Action connectors** (new) | Operations for flows, apps and agents: send WhatsApp, create Tally voucher, call a REST API, fetch GST details | `ActionConnector { kind, manifest, test(), invoke(operationId, input, ctx) }` |

**Action connector manifest** (JSON, our own format, generated from or convertible to OpenAPI 3.x):

```jsonc
{
  "kind": "rest", "name": "razorpay", "displayName": "Razorpay", "version": "1.0.0",
  "auth": { "type": "apiKey" | "basic" | "oauth2" | "none", "fields": [...], "oauth": { "authUrl", "tokenUrl", "scopes" } },
  "baseUrl": "https://api.razorpay.com/v1",
  "operations": [
    { "id": "createPaymentLink", "title": "Create payment link", "method": "POST", "path": "/payment_links",
      "input": { /* JSON Schema */ }, "output": { /* JSON Schema */ },
      "sideEffect": true, "idempotencyHeader": "X-Idempotency-Key" }
  ],
  "triggers": [ { "id": "paymentCaptured", "type": "webhook", "verify": { "hmacHeader": "X-Razorpay-Signature" } } ],
  "rateLimit": { "perMinute": 120 }
}
```

- **Built-ins** ship as TypeScript modules for things that need code (SMTP, IMAP, WhatsApp Business Cloud API, Tally agent, LLM providers). **Declarative REST connectors** are manifests interpreted by one generic HTTP runtime; makers can create them by importing an OpenAPI 3 or 2 file, a Postman collection, or a cURL example, then test operations in a UI. Store manifests in `ab_connector_defs(id, name, version, manifest, source: 'builtin'|'custom', created_by)`.
- **Connections** stay in `ab_connections`; add `connector_def_id`, `auth_mode ENUM('shared','per_user')`, and `ab_user_connections(connection_id, user_id, secret_sealed, expires_on)` for per-user OAuth tokens (Google, Microsoft 365). Refresh tokens are sealed with the workspace key (`server/core/secrets.ts`) and **never** leave the server.
- **Connection references** in solutions: a solution lists `connectionRefs: [{ name, connectorKind }]`; apps, flows and agents refer to `ref:<name>`; import asks the admin to map each reference to an existing connection or create one. This fits our YAML solution format directly.
- **Calls from apps**: Fx `Connector.Razorpay.CreatePaymentLink({...})` goes to `POST /api/v1/connectors/:connectionRef/invoke/:operationId`; the server checks the role is allowed to use that connection and operation (`ab_connection_grants(connection_id, role_id, operations JSON)`), injects credentials, applies rate limits and timeouts, writes `ab_audit`, and returns the result. The browser never sees the credential — same model as Microsoft's secure implicit connections, but by design from day one.
- **Rate limiting**: token bucket per connection in memory (single process), configurable per manifest; a 429 from upstream is retried by the flow engine with backoff.
- **Webhook triggers** from external services land on `POST /api/v1/hooks/c/:connectionId/:triggerId/:secret` and fan out to subscribed flows (see `power-automate.md`).

### On-prem reach without a gateway product

Our default deployment **is** on-prem (a PC on the plant LAN), so the server reaches local MySQL, SQL Server, file shares and the Tally PC directly — no gateway needed. For the VPS deployment, provide a small **agent** (Node single binary) that runs on a LAN machine, opens an outbound WebSocket to the server (`wss://.../api/v1/agents/connect` with an enrolment token), and executes connector calls for connections marked `via_agent = <agentId>`. Same idea as the gateway (outbound only, credentials decrypted on the agent with a key generated at enrolment), without Azure Relay. The sector research already says Tally is reachable only through a local agent, so this agent is needed anyway; build it once, generically.

### Policy

One table: `ab_connection_policies(env_id, connector_kind, allowed TINYINT)` plus per-connection `allowed_env_ids`. Checked at design time (Studio and flow designer hide disallowed connectors) and at run time (invoke refuses). No Business/Non-Business mixing rule: for a 30-person company, "which external services are allowed at all" is the question that matters.

## Where we can be better for a 20-50 person org

| Microsoft pain point | Evidence | Better design |
|---|---|---|
| Premium paywall: SQL Server, HTTP, custom connectors and gateway use need premium licences for every user | [Connectors list](https://learn.microsoft.com/power-apps/maker/canvas-apps/connections-list#popular-connectors), [custom connector limits](https://learn.microsoft.com/power-automate/limits-and-config#request-limits) | All connectors included. Price the product, not the plumbing. |
| Shared credentials were for years reusable by any app user; fixed only for connections created after Jan 2024 and republished apps | [Secure implicit connections](https://learn.microsoft.com/power-apps/maker/canvas-apps/connections-list#security-and-types-of-authentication) | Credentials server-side only; per-role operation grants. |
| Swagger 2.0 only, 1 MB cap, ASCII headers | [OpenAPI prerequisites](https://learn.microsoft.com/connectors/custom-connectors/define-openapi-definition#prerequisites) | Accept OpenAPI 3.x, Postman, cURL; convert to our manifest. |
| Changing a custom connector means removing and re-adding it in every app | [Custom connector lifecycle](https://learn.microsoft.com/connectors/custom-connectors/#lifecycle) | Versioned manifests; apps refer to operation ids; schema changes flagged in App checker. |
| Connection vs connection reference vs data-source environment variable — three concepts for one "which system do I talk to" | [Connection references](https://learn.microsoft.com/power-apps/maker/data-platform/create-connection-reference), [env var FAQ](https://learn.microsoft.com/power-apps/maker/data-platform/environment-variables-faq) | Connection (credential + parameters) and a solution reference to it. Two concepts. |
| Gateway: Windows-only, manual monthly updates, only last six versions supported, region-bound, recovery key to manage | [Gateway overview](https://learn.microsoft.com/data-integration/gateway/service-gateway-onprem), [port usage](https://learn.microsoft.com/power-platform/admin/wp-onpremises-gateway#port-usage) | Usually unnecessary (on-prem server); otherwise a cross-platform agent with self-update from our server. |
| Three throttling layers to reason about | [Understand limits](https://learn.microsoft.com/power-automate/guidance/coding-guidelines/understand-limits#api-throughput-limits-on-connectors) | Only the upstream service's own limits, handled by retries. |
| DLP mixing rules confuse makers | [Impact of data policies](https://learn.microsoft.com/power-platform/admin/dlp-impact-policies-apps-flows) | Simple allowlist. |

**Not worth replicating**: APIM/App Service hosting per connector, connector certification marketplace, policy templates and C# custom code in connectors, x-ms extension zoo, OAuth redirect URI per connector migration machinery, the Business/Non-Business model.

**Worth copying**: OpenAPI as the import format, operations with input/output schemas (they double as **agent tools** — see `copilot-studio.md`), polling and webhook trigger contracts, connection references in solutions, outbound-only on-prem agent design, encrypt-at-cloud / decrypt-at-agent credential handling.

## Sources

- [Connectors architecture](https://learn.microsoft.com/connectors/connector-architecture)
- [Custom connectors overview](https://learn.microsoft.com/connectors/custom-connectors/)
- [Create a custom connector from an OpenAPI definition](https://learn.microsoft.com/connectors/custom-connectors/define-openapi-definition)
- [Get your connector certified](https://learn.microsoft.com/connectors/custom-connectors/submit-certification)
- [Use a connection reference in a solution](https://learn.microsoft.com/power-apps/maker/data-platform/create-connection-reference)
- [Overview of connectors for canvas apps](https://learn.microsoft.com/power-apps/maker/canvas-apps/connections-list)
- [Share resources used by canvas apps](https://learn.microsoft.com/power-apps/maker/canvas-apps/share-app-resources)
- [App performance considerations](https://learn.microsoft.com/power-apps/maker/canvas-apps/app-performance-considerations)
- [Limits of automated, scheduled, and instant flows](https://learn.microsoft.com/power-automate/limits-and-config)
- [Power Automate licensing FAQ](https://learn.microsoft.com/power-platform/admin/power-automate-licensing/faqs)
- [Understand platform limits and avoid throttling](https://learn.microsoft.com/power-automate/guidance/coding-guidelines/understand-limits)
- [What is an on-premises data gateway?](https://learn.microsoft.com/data-integration/gateway/service-gateway-onprem)
- [About on-premises gateway (Power Platform)](https://learn.microsoft.com/power-platform/admin/wp-onpremises-gateway)
- [Install on-premises data gateway for Logic Apps](https://learn.microsoft.com/azure/logic-apps/install-on-premises-data-gateway-workflows)
- [Power Platform architecture and ExpressRoute](https://learn.microsoft.com/power-platform/architecture/key-concepts/expressroute/understanding-architecture)
- [Power Automate for desktop architecture](https://learn.microsoft.com/power-automate/desktop-flows/pad-architecture)
- [Data policy strategy](https://learn.microsoft.com/power-platform/guidance/adoption/dlp-strategy)
- [Connector classification](https://learn.microsoft.com/power-platform/admin/dlp-connector-classification)
- [Impact of data policies on apps and flows](https://learn.microsoft.com/power-platform/admin/dlp-impact-policies-apps-flows)
- [Advanced connector policies](https://learn.microsoft.com/power-platform/admin/advanced-connector-policies)
