# Copilot Studio

Research date: 18 November 2026. Sources are Microsoft Learn pages retrieved on that date. This product changed substantially during 2025-2026; every statement about current behaviour below comes from a page fetched on the research date. Opinions are labelled *inference*; unconfirmed claims are labelled *unverified*.

## 0. The 2026 picture: three "harnesses"

The most important current fact: Copilot Studio is no longer one runtime. Microsoft now describes a **harness** as the runtime between what you build and the model — it decides when to call the model, what to send, how to interpret the reply and which tools to call — and there are three ([harnesses overview](https://learn.microsoft.com/microsoft-copilot-studio/harnesses-overview)):

| Harness | For | How it works | Billing |
|---|---|---|---|
| **Microsoft Copilot harness** | Reasoning-heavy, multi-step business processes | Takes a goal, plans steps, calls tools (connectors, knowledge, MCP, connected agents), retries and finds alternatives; creates/edits Word, Excel, PowerPoint, PDF; supports skills and memory; each task runs in a governed sandbox | Usage-based Copilot Credits for LLM tokens, tools and the harness, **charged from the moment you start building** (preview, testing, evaluations included) ([usage-based billing](https://learn.microsoft.com/microsoft-copilot-studio/agents-experience/billing-credit-overview)) |
| **Customer Conversation harness** | Customer-facing chat and voice, contact-centre style | Multi-agent architecture of specialised sub-agents with escalation to humans; website chat or phone number | Copilot Credits, by conversation complexity and modality |
| **Standard harness** | Rule-based agents, structured conversations, **agent flows** | Topics and rules you define, with generative or classic orchestration (the "classic" Copilot Studio most documentation describes) | Per-feature Copilot Credit rates, billed after publish ([billing rates](https://learn.microsoft.com/microsoft-copilot-studio/requirements-messages-management)) |

Copilot Studio also now distinguishes **agents**, **workflows** (a newer AI-native drag-and-drop automation where each step can reason) and **agent flows** (the established Power Automate-like flow format, now part of the standard harness) ([Copilot Studio overview](https://learn.microsoft.com/microsoft-copilot-studio/fundamentals-what-is-copilot-studio#what-you-can-build), [agent flows](https://learn.microsoft.com/microsoft-copilot-studio/flows-overview)). Some admin URLs and the skills page refer to a "GitHub Copilot harness", apparently an earlier name for the Microsoft Copilot harness ([usage-based billing links](https://learn.microsoft.com/microsoft-copilot-studio/agents-experience/billing-credit-overview), [publish fundamentals note](https://learn.microsoft.com/microsoft-copilot-studio/publication-fundamentals-publish-channels)) — *the naming relationship is an inference*.

Most of the detailed documentation below is for the **standard harness**, which is the closest analogue to the minimal agent builder Appbuilder plans.

## 1. How an agent is defined (standard harness)

An agent has: **instructions** (system prompt), **knowledge sources**, **tools**, **topics**, **other agents** (child or connected), **triggers**, settings (model, moderation, orchestration mode, authentication) and **channels**.

### Topics and triggers

A **topic** is an authored conversation path: nodes for messages, questions (slot filling), conditions, variable operations, calls to tools/flows, generative answers, redirects ([create topics](https://learn.microsoft.com/microsoft-copilot-studio/authoring-create-edit-topics)). Limits: 1,000 topics per agent, 200 trigger phrases per topic ([quotas](https://learn.microsoft.com/microsoft-copilot-studio/requirements-quotas#limits)).

Trigger types ([topic triggers](https://learn.microsoft.com/microsoft-copilot-studio/authoring-triggers#trigger-types)): *The agent chooses* (generative orchestration, by description), *User says a phrase* (classic, NLU over trigger phrases), message received, custom client event, any activity, conversation update, invoke (Teams), redirect, user inactive, **a plan completes**, **an AI-generated response is about to be sent** (lets you rewrite or suppress the response). An advanced `OnKnowledgeRequested` hook — enabled by naming a topic exactly that in YAML — intercepts the search phrase before knowledge search and can inject custom results ([generative orchestration guidance](https://learn.microsoft.com/microsoft-copilot-studio/guidance/generative-orchestration#custom-triggers-in-generative-orchestration)).

**Event triggers** make an agent **autonomous**: for example, run when a Dataverse row is created; the orchestrator decides which tool/topic/agent to invoke from event data and instructions ([generative orchestration FAQ](https://learn.microsoft.com/microsoft-copilot-studio/faqs-generative-orchestration)).

### Generative vs classic orchestration

Default for new agents is generative ([orchestration](https://learn.microsoft.com/microsoft-copilot-studio/advanced-generative-actions)):

| | Generative | Classic |
|---|---|---|
| Topic selection | By name and description | By trigger phrases |
| Tools | Agent may call them by name/description | Only explicitly from topics |
| Knowledge | Searched proactively | Fallback when no topic matches, or explicit node |
| Multiple capabilities per turn | Yes, chained in sequence | One topic |
| Missing inputs | Auto-generated questions | Authored question nodes |
| Response | Generated from all outputs + instructions | Authored message nodes |
| Child/connected agents | Selected by description | n/a |

The planner uses the **last 10 turns** of history to fill inputs; descriptions are the most important selection signal; with more than 25 knowledge sources an internal model pre-filters them ([FAQ](https://learn.microsoft.com/microsoft-copilot-studio/faqs-generative-orchestration), [knowledge search modes](https://learn.microsoft.com/microsoft-copilot-studio/knowledge-copilot-studio#knowledge-search-in-classic-and-generative-modes)). Admins can disable generative orchestration per environment.

### Tools (formerly actions)

Tool types include Power Platform connectors (prebuilt and custom), agent flows (with the *When an agent calls the flow* trigger) ([agent flows with agents](https://learn.microsoft.com/microsoft-copilot-studio/advanced-flow)), prompts (AI Builder prompt tools), REST APIs, computer use, and **MCP servers**. Each tool has a name, description, inputs and outputs that the planner reads.

**MCP**: supported for **tools and resources** (not prompts); **Streamable HTTP** transport only (SSE dropped after August 2025); generative orchestration required; tools added/removed on the server are reflected dynamically; auth none, API key (header or query) or OAuth 2.0 (dynamic discovery with DCR, dynamic, or manual). Two setup paths: an MCP onboarding wizard, or a custom connector with an OpenAPI schema describing the MCP endpoint ([extend with MCP](https://learn.microsoft.com/microsoft-copilot-studio/agent-extend-action-mcp), [connect existing MCP server](https://learn.microsoft.com/microsoft-copilot-studio/mcp-add-existing-server-to-agent)). MCP servers can also be registered org-wide through Microsoft Agent 365 (preview) with admin approval. Copilot Studio agents can themselves be **exposed** to external clients through **MCP client** and **A2A client** channels (preview, early-release environments) ([MCP/A2A channels](https://learn.microsoft.com/microsoft-copilot-studio/agents-experience/publication-channels-mcp-agent-to-agent#connect-a-client-to-the-agent)).

### Multi-agent

- **Child agents** live inside the parent agent; **connected agents** are separate published agents the parent delegates to by description (Copilot Studio agents, and A2A agents) ([orchestration table](https://learn.microsoft.com/microsoft-copilot-studio/advanced-generative-actions)).
- Sharing: with the Microsoft Copilot harness, sharing the parent is enough; with the standard harness you may need to share connected agents separately. Data access is governed by each tool's connection — a tool using **agent author authentication** returns data with the author's credentials to anyone who can use the parent; Microsoft warns not to rely on leaving a connected agent unshared ([connected agents](https://learn.microsoft.com/microsoft-copilot-studio/agents-experience/add-agent-connected#sharing-and-connector-access)).

## 2. Knowledge and grounding

Supported knowledge sources ([knowledge summary](https://learn.microsoft.com/microsoft-copilot-studio/knowledge-copilot-studio#supported-knowledge-sources)):

| Source | How it's searched | Limit (generative / classic) | Auth |
|---|---|---|---|
| Public website | **Bing** search restricted to the given sites | 25 / 4 URLs | None |
| Uploaded documents | Stored in Dataverse, searched over contents | All / limited by Dataverse file capacity | None |
| SharePoint | **Microsoft Graph Search**; only the top 3 results are used to summarise ([SharePoint troubleshooting](https://learn.microsoft.com/troubleshoot/power-platform/copilot-studio/generative-answers/sharepoint-no-response)) | 25 / 4 URLs | End user's Entra identity |
| Dataverse | A **RAG technique in Dataverse** over selected tables | Unlimited / 2 sources × 15 tables | End user's Entra identity |
| Copilot (Graph) connectors | External data indexed into Microsoft Graph, source permissions respected ([Copilot connectors](https://learn.microsoft.com/microsoft-copilot-studio/knowledge-copilot-connectors)) | Unlimited / 2 | End user's Entra identity |
| Classic-only | Azure OpenAI on your data, Bing Custom Search, custom data via the generative answers node | | |

Important details:

- **User-scoped retrieval**: for authenticated sources the agent only surfaces content the asking user can access.
- **Dataverse search is required** for SharePoint/OneDrive "unstructured data" sources; enabling it can take 5-30 minutes to index; max **500 knowledge objects** per agent and **5 different source types at a time**; users need at least a Basic User licence plus read on several plug-in system tables ([unstructured data](https://learn.microsoft.com/microsoft-copilot-studio/knowledge-unstructured-data#limits-and-limitations), [SharePoint content](https://learn.microsoft.com/microsoft-copilot-studio/nlu-generative-answers-sharepoint-onedrive)).
- **File size**: SharePoint files over 7 MB aren't processed unless the tenant has a Microsoft 365 Copilot licence and "tenant graph grounding with semantic search" is on (then 200 MB); uploaded files up to 512 MB ([file size limits](https://learn.microsoft.com/troubleshoot/power-platform/copilot-studio/knowledge/sharepoint-no-response#file-size-limits-for-sharepoint-generative-answers)).
- **Tenant graph grounding with semantic search** uses the Microsoft 365 **semantic index**; requires at least one M365 Copilot licence in the tenant and "Authenticate with Microsoft"; costs extra credits ([knowledge settings](https://learn.microsoft.com/microsoft-copilot-studio/knowledge-copilot-studio#knowledge-source-agent-settings)).
- **Content moderation** levels Lowest to Highest (default High) at agent, topic and prompt level.
- Citations can't yet be passed as inputs to other tools.
- Knowledge search is language-agnostic across supported file types.

The underlying index technology for Dataverse RAG isn't named on the pages fetched (*unverified*).

## 3. Channels and authentication

**Channels** ([publish fundamentals](https://learn.microsoft.com/microsoft-copilot-studio/publication-fundamentals-publish-channels#configure-channels)): Teams and Microsoft 365 Copilot, SharePoint, WhatsApp, demo website, custom website (embed), mobile app (Direct Line), Facebook, and Azure Bot Service channels (Slack, Telegram, Twilio, LINE, email, Direct Line Speech...). Publishing updates all connected channels; admins can restrict channels through data policies and **Agent access channels** in PPAC.

**End-user authentication** ([multitenant overview](https://learn.microsoft.com/microsoft-copilot-studio/multi-tenant-overview), [configure authentication](https://learn.microsoft.com/microsoft-copilot-studio/configuration-end-user-authentication)):

| Option | Behaviour |
|---|---|
| No authentication | Anyone with the link can chat; tools can't use user credentials |
| Authenticate with Microsoft (default) | Entra SSO in Teams, Power Apps, Microsoft Copilot; required for Microsoft channels |
| Authenticate manually | OAuth 2.0 (any provider, e.g. Google) or Entra options configured by the maker; for websites/apps with external users |

Teams limitations: in group chats and channels, agents can't use knowledge requiring end-user auth (1:1 only); Teams rate-limits bots; users can't explicitly sign out ([Teams channel limitations](https://learn.microsoft.com/microsoft-copilot-studio/publication-add-bot-to-microsoft-teams#known-limitations)).

## 4. Analytics and monitoring

The **Monitor** page shows conversational or autonomous agent metrics; data kept up to 360 days, session details and transcripts for 28 days; test-panel activity excluded; view-only *Analytics Viewer* sharing role, transcript access needs the *Bot Transcript Viewer* security role ([analytics](https://learn.microsoft.com/microsoft-copilot-studio/analytics-overview)). Agent flows have Activity (run history, resubmit, cancel) and Analytics tabs, with run data appearing up to 30 minutes late ([monitor agent flows](https://learn.microsoft.com/microsoft-copilot-studio/flow-manage-monitor)). Evaluations (test sets with graders) are part of the newer experience ([overview](https://learn.microsoft.com/microsoft-copilot-studio/fundamentals-what-is-copilot-studio#manage-and-operate-your-solutions)).

## 5. Governance controls

- **Data policies** classify Copilot Studio-specific connectors (for example "Chat without Microsoft Entra ID authentication", "Direct Line channels", knowledge source types, HTTP) into Business / Non-Business / Blocked, enforced in real time ([agent data policies](https://learn.microsoft.com/microsoft-copilot-studio/admin-data-loss-prevention#prerequisites)).
- **Environment group rules** for Copilot: transcript access, AI prompts, generative AI settings, sharing agents with editors/viewers, drawing from the tenant credit pool, Global Secure Access settings ([rules](https://learn.microsoft.com/power-platform/admin/environment-groups-rules), [rules gallery](https://learn.microsoft.com/power-platform/admin/environment-group-rules-gallery#rule-lifecycle-in-an-environment-group)).
- Admin can disable generative orchestration per environment, block viral trial sign-ups, inventory agents, set per-agent monthly credit limits ([billing](https://learn.microsoft.com/microsoft-copilot-studio/requirements-messages-management#how-tokens-are-counted-for-reasoning-models)), and log agent activity to Purview.
- Secrets: environment variables of type secret (Azure Key Vault) with `AllowedAgents`/`AllowedEnvironments` tags; Microsoft warns anyone who can edit the agent can echo a secret in a message node ([variables](https://learn.microsoft.com/microsoft-copilot-studio/authoring-variables#use-environment-variables-for-azure-key-vault-secrets)).
- Microsoft's own governance guidance describes a five-phase programme (requirements, zoned environments, security, testing, ALM, monitoring) ([governance overview](https://learn.microsoft.com/microsoft-copilot-studio/guidance/sec-gov-intro)).

## 6. Pricing unit

**Copilot Credits** (formerly "messages"), pooled across the tenant, enforced monthly, no rollover; exceeding capacity can cause service denial ([licensing](https://learn.microsoft.com/microsoft-copilot-studio/billing-licensing#get-access-to-copilot-studio)). Standard-harness rates ([billing rates](https://learn.microsoft.com/microsoft-copilot-studio/requirements-messages-management#copilot-credits-billing-rates)):

| Feature | Credits |
|---|---|
| Classic (authored) answer | 1 |
| Generative answer | 2 |
| Agent action (trigger, reasoning step, topic transition, tool call; computer-use agents too) | 5 |
| Tenant graph grounding per message | 10 |
| Agent flow actions | 13 per 100 actions (each trigger execution counts, including failed polling evaluations) |
| Text/generative AI tools basic / standard | 1 / 15 per 10 responses |
| Text/generative AI tools premium (reasoning models) | 10 per 1,000 billed tokens (cache reads not billed) |
| Content processing | 8 per page |
| Voice | 10 / 35 / 75 per minute by tier |

Examples from the page: a website support agent with 4 classic + 2 generative answers per conversation × 900 customers/day = 7,200 credits/day; a reasoning-model follow-up question can cost ~141-461 credits for one message. Employee-facing use by Microsoft 365 Copilot-licensed users is not charged for classic/generative answers and graph grounding (fair use). Test-panel chats are free in the standard harness ([billing FAQ](https://learn.microsoft.com/microsoft-copilot-studio/faq-billing-licensing#do-chats-in-the-embedded-test-chat-count-as-billable-copilot-credits)); not so in the Microsoft Copilot harness. Credit pack prices weren't on fetched pages (*unverified*). The billing examples name third-party reasoning models (Claude Opus 4.7) alongside GPT-5 chat, so model choice is now multi-vendor.

## How to replicate on our stack (single Node server + MySQL)

Scope: a **minimal agent builder** — agents with instructions, tools, RAG over company data, an LLM via API — embedded in apps, the portal and the planned team chat. Not a contact-centre product, not a general-purpose reasoning harness.

### Data model

```sql
ab_ai_providers(id, kind ENUM('openai_compat','anthropic','azure_openai','gemini','ollama'), base_url, model_default,
                secret_sealed, monthly_budget_inr, enabled)
ab_agents(id, env_id, name, description, instructions TEXT, provider_id, model, temperature,
          visibility_roles JSON, channels JSON, auth ENUM('internal','site_users','public'), version, published_version)
ab_agent_tools(agent_id, tool_id, kind ENUM('table_query','table_write','flow','connector_op','mcp','http'),
               config JSON, description, requires_confirmation TINYINT)
ab_agent_knowledge(agent_id, source_id)
ab_knowledge_sources(id, kind ENUM('doclib_folder','table','url','upload'), config JSON, last_indexed, status)
ab_kb_chunks(id, source_id, doc_id, chunk_no, text MEDIUMTEXT, meta JSON, acl_key VARCHAR(191),
             embedding BLOB NULL, tokens INT, FULLTEXT KEY ft_text (text), KEY ix_acl (acl_key))
ab_agent_conversations(id, agent_id, user_id, channel, started_on, last_on)
ab_agent_messages(conversation_id, seq, role ENUM('user','assistant','tool'), content MEDIUMTEXT, tool_calls JSON,
                  citations JSON, tokens_in, tokens_out, cost_inr DECIMAL(10,4), created_on)
ab_agent_feedback(message_id, user_id, rating, comment)
```

### Runtime (one loop, provider-agnostic)

1. Build the prompt: agent instructions + date/user context + tool schemas (JSON Schema from table definitions, flow manual-trigger inputs, connector operation schemas from `connectors.md`, MCP `tools/list`) + last N turns.
2. Call the provider with native tool calling (OpenAI-compatible, Anthropic, Gemini adapters; Ollama for on-prem/offline pilots). Stream tokens to the client over SSE.
3. Execute tool calls **as the end user** through existing services: `table_query` → `DataService.query` (RBAC/RLS/CLS apply, so the agent can never see more than the user); `table_write` and side-effecting tools require an **in-chat confirmation card** by default; `flow` → flow engine manual trigger; `connector_op` → connector invoke; `mcp` → MCP client (Streamable HTTP) with per-server allowlisted tools.
4. Loop until a final answer or a step limit (default 8 tool calls), then persist messages, citations, token counts and cost.

No topics in v1. A "deterministic topic" need is better served by an **agent calling a flow** — reuses the flow engine instead of a second dialog designer. Add a small "starter prompts" and "canned answers" list for FAQs (cheap, predictable).

### RAG over company data

- **Structured data** (tables): don't embed rows. Expose tables as tools with filters (the LLM writes our query JSON; the server validates it against the schema and applies the user's predicate). Add a `table_search` tool backed by MySQL FULLTEXT for fuzzy lookups ("find the NCR about bearing noise").
- **Documents** (planned document library, uploads, URLs): extract text (PDF, DOCX, XLSX, HTML; OCR optional via a connector), chunk (~800 tokens with overlap, heading-aware), embed via the provider's embedding API (or a local model through Ollama), store in `ab_kb_chunks`.
- **Vector search without a new database**: D7 requires MySQL 5.7+/MariaDB 10.4+, which lack vector types. For 20-50 users the corpus is small (thousands to low hundreds of thousands of chunks), so load embeddings for the agent's sources into memory (Float32Array per source, invalidated on reindex) and do brute-force cosine in Node — a few milliseconds per 100k × 1024-dim vectors with SIMD-free loops is still fine (*inference*; benchmark before committing). Combine with FULLTEXT scores (hybrid, reciprocal rank fusion). If the install has MySQL 9 (VECTOR type) or MariaDB 11.7+ (vector index), use them opportunistically behind the same interface.
- **Permission-aware retrieval**: every chunk carries `acl_key` (document library folder id or table id + row id). Before ranking, filter to chunks whose ACL the user passes (folder permissions from the document library; row predicate for table-derived chunks). This mirrors Microsoft's "only surfaces content the user can access" — done by us, not by Graph.
- **Citations**: return `[n]` markers mapped to document id + page/heading; render as links into the document library viewer.
- **Indexing jobs** run on the flow engine's job runner (same durable queue), incremental by document `modified_on`.

### Channels

Portal chat panel; embeddable **Agent** control in canvas apps (Fx: `Agent.Ask("QC Helper", TextInput1.Value)` for single-shot use, and a Chat control bound to an agent); the planned team chat (agents as members, @mention); public website widget on Power Pages-equivalent sites for site users or anonymous (anonymous agents get **no** table tools except explicitly whitelisted public views); WhatsApp via the WhatsApp connector later. Expose agents to external clients as an **MCP server** endpoint (`/api/v1/mcp`) — cheap to add and increasingly expected.

### Governance and cost

- Per provider and per agent monthly budgets in INR with hard stop and 80% alert; per-user daily message cap; costs shown per conversation in the Monitor view.
- Admin switches: which providers/models are allowed (including "local only" for data residency), whether agents can use write tools, whether public agents are allowed.
- Transcripts stored in our DB with retention (default 90 days) and redaction of secrets; only admins and agent owners see transcripts.
- Prompt-injection hygiene: tool results are wrapped as data, write tools need confirmation, MCP servers are allowlisted per agent, and agents can't read secrets (credentials never enter the prompt).

## Where we can be better for a 20-50 person org

| Microsoft pain point | Evidence | Better design |
|---|---|---|
| Three harnesses with different features and billing; terminology churn (messages → credits, actions → tools, harness renames) | [Harnesses](https://learn.microsoft.com/microsoft-copilot-studio/harnesses-overview), [usage-based billing](https://learn.microsoft.com/microsoft-copilot-studio/agents-experience/billing-credit-overview) | One runtime. Cost = what the LLM provider charges, shown in rupees. |
| Credit accounting per feature (1/2/5/10/13-per-100) plus token-based premium rates; Microsoft Copilot harness bills even while building and testing | [Billing rates](https://learn.microsoft.com/microsoft-copilot-studio/requirements-messages-management#copilot-credits-billing-rates) | Pass-through provider cost, budgets, and a free local-model option. |
| Good SharePoint grounding effectively requires Microsoft 365 Copilot licences (7 MB vs 200 MB files, semantic index) | [File size limits](https://learn.microsoft.com/troubleshoot/power-platform/copilot-studio/knowledge/sharepoint-no-response#file-size-limits-for-sharepoint-generative-answers) | Our own index; same quality for every user. |
| Unstructured knowledge requires Dataverse search, Basic User licences and read access to plug-in system tables | [Unstructured data limits](https://learn.microsoft.com/microsoft-copilot-studio/knowledge-unstructured-data#limits-and-limitations) | No prerequisites beyond the install. |
| Only top 3 SharePoint search results used | [SharePoint troubleshooting](https://learn.microsoft.com/troubleshoot/power-platform/copilot-studio/generative-answers/sharepoint-no-response) | Configurable k, hybrid ranking, visible retrieval trace in Monitor. |
| Tools with author credentials can leak data through connected agents | [Connected agents](https://learn.microsoft.com/microsoft-copilot-studio/agents-experience/add-agent-connected#sharing-and-connector-access) | Tools always run as the end user against our security engine; service-account tools are an explicit, flagged exception. |
| Secrets readable by anyone who can edit the agent | [Variables](https://learn.microsoft.com/microsoft-copilot-studio/authoring-variables#use-environment-variables-for-azure-key-vault-secrets) | Credentials stay in connectors, never in agent variables or prompts. |
| Teams group chats can't use authenticated knowledge | [Teams limitations](https://learn.microsoft.com/microsoft-copilot-studio/publication-add-bot-to-microsoft-teams#known-limitations) | Our chat knows each participant; answer with the asker's permissions and say so. |

**Not worth replicating**: topics with trigger-phrase NLU (classic orchestration), the topic canvas, voice/IVR, 20 Azure Bot Service channels, computer-use agents, tenant graph grounding, Customer Conversation multi-agent escalation, evaluations framework beyond a simple saved test set, A2A (watch it), autonomous event-triggered agents in v1 (use flows that call an agent instead — same effect, deterministic trigger).

**Worth copying**: description-driven tool selection, user-scoped retrieval, citations, MCP (Streamable HTTP) for tools, exposing agents as MCP servers, the "response about to be sent" hook (as a post-processing Fx/flow option), per-agent budget limits, transcript retention with restricted viewing, starter prompts.

**Honest scope note**: for a manufacturer pilot, two agents will deliver most of the value: a **"Ask the SOPs" agent** over the document library (quality manuals, work instructions, machine manuals) and a **"Ask the data" agent** that answers questions over production/QC/maintenance tables through the query tool. Build those end to end before any generality.

## Sources

- [Harnesses in Copilot Studio](https://learn.microsoft.com/microsoft-copilot-studio/harnesses-overview)
- [Copilot Studio overview](https://learn.microsoft.com/microsoft-copilot-studio/fundamentals-what-is-copilot-studio)
- [Overview of usage-based billing](https://learn.microsoft.com/microsoft-copilot-studio/agents-experience/billing-credit-overview)
- [Billing rates and management](https://learn.microsoft.com/microsoft-copilot-studio/requirements-messages-management)
- [Licensing for agents powered by the standard harness](https://learn.microsoft.com/microsoft-copilot-studio/billing-licensing)
- [Billing and licensing FAQ](https://learn.microsoft.com/microsoft-copilot-studio/faq-billing-licensing)
- [Orchestrate agent behavior with generative AI](https://learn.microsoft.com/microsoft-copilot-studio/advanced-generative-actions)
- [Apply generative orchestration capabilities](https://learn.microsoft.com/microsoft-copilot-studio/guidance/generative-orchestration)
- [FAQ for generative orchestration](https://learn.microsoft.com/microsoft-copilot-studio/faqs-generative-orchestration)
- [Create and edit topics](https://learn.microsoft.com/microsoft-copilot-studio/authoring-create-edit-topics)
- [Set topic triggers](https://learn.microsoft.com/microsoft-copilot-studio/authoring-triggers)
- [Quotas and limits](https://learn.microsoft.com/microsoft-copilot-studio/requirements-quotas)
- [Knowledge sources summary](https://learn.microsoft.com/microsoft-copilot-studio/knowledge-copilot-studio)
- [Use generative answers in a topic](https://learn.microsoft.com/microsoft-copilot-studio/nlu-boost-node)
- [Unstructured data as a knowledge source](https://learn.microsoft.com/microsoft-copilot-studio/knowledge-unstructured-data)
- [Use SharePoint content](https://learn.microsoft.com/microsoft-copilot-studio/nlu-generative-answers-sharepoint-onedrive)
- [SharePoint sources don't return results](https://learn.microsoft.com/troubleshoot/power-platform/copilot-studio/generative-answers/sharepoint-no-response)
- [SharePoint knowledge file size limits](https://learn.microsoft.com/troubleshoot/power-platform/copilot-studio/knowledge/sharepoint-no-response)
- [Add Copilot connectors as knowledge](https://learn.microsoft.com/microsoft-copilot-studio/knowledge-copilot-connectors)
- [Extend your agent with MCP](https://learn.microsoft.com/microsoft-copilot-studio/agent-extend-action-mcp)
- [Connect to an existing MCP server](https://learn.microsoft.com/microsoft-copilot-studio/mcp-add-existing-server-to-agent)
- [Add MCP tools and resources](https://learn.microsoft.com/microsoft-copilot-studio/mcp-add-components-to-agent)
- [MCP and A2A client channels (preview)](https://learn.microsoft.com/microsoft-copilot-studio/agents-experience/publication-channels-mcp-agent-to-agent)
- [Add a connected agent (Microsoft Copilot harness)](https://learn.microsoft.com/microsoft-copilot-studio/agents-experience/add-agent-connected)
- [Agent flows overview](https://learn.microsoft.com/microsoft-copilot-studio/flows-overview)
- [Use agent flows with your agent](https://learn.microsoft.com/microsoft-copilot-studio/advanced-flow)
- [Monitor agent flows](https://learn.microsoft.com/microsoft-copilot-studio/flow-manage-monitor)
- [Publish and deploy your agent](https://learn.microsoft.com/microsoft-copilot-studio/publication-fundamentals-publish-channels)
- [Teams and Microsoft Copilot channel](https://learn.microsoft.com/microsoft-copilot-studio/publication-add-bot-to-microsoft-teams)
- [Configure user authentication](https://learn.microsoft.com/microsoft-copilot-studio/configuration-end-user-authentication)
- [Multitenant mode overview (authentication options)](https://learn.microsoft.com/microsoft-copilot-studio/multi-tenant-overview)
- [Monitor agent performance](https://learn.microsoft.com/microsoft-copilot-studio/analytics-overview)
- [Configure data policies for agents](https://learn.microsoft.com/microsoft-copilot-studio/admin-data-loss-prevention)
- [Governance overview](https://learn.microsoft.com/microsoft-copilot-studio/guidance/sec-gov-intro)
- [Work with variables (Key Vault secrets)](https://learn.microsoft.com/microsoft-copilot-studio/authoring-variables)
- [Rules for environment groups](https://learn.microsoft.com/power-platform/admin/environment-groups-rules)
