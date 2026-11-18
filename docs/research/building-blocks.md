# Building blocks: what to embed, what to use as a library, what to build

Research date: 18 Nov 2026. Scope: Appbuilder sold as closed or source-available software, one install on an on-prem Windows PC or a small Linux VPS (2-4 vCPU, 4-8 GB RAM), Node 22 + MySQL 8 / MariaDB 10.4+ + React 19, for organisations of 20-50 people.

**Method.** Licence files were read from each repository (raw GitHub). Versions and dates come from npm, PyPI, Docker Hub and the Go proxy. Prices come from vendors' live pages and APIs on the research date. Anything not confirmed is marked **unverified**. Effort and cost figures are **estimates**. Licence conclusions are my reading of the text: **not legal advice, needs a lawyer**.

Decision D5 already says only MIT/Apache/BSD code ships inside the product, and this document uses it as the bar.

**Verdict labels:**
- **Embed**: a separate process integrated over HTTP/iframe.
- **Library**: imported into our code.
- **Design only**: learn from it, write our own code.
- **Build**: our own code from scratch.

---

## 1. Office documents in the browser

| Project | Licence (verified) | Activity | Footprint | Integration | Real OOXML fidelity | Verdict |
|---|---|---|---|---|---|---|
| ONLYOFFICE Docs Community | AGPL-3.0 **+ added terms** (About-section attribution, no trademark rights) | Docker 10.0, 12 Oct 2026 | Windows Server 2016+ installer or Linux; ≥2 GB RAM, 2 cores, 40 GB disk | iframe + Docs API (JWT, save callback); React wrapper Apache-2.0 | Yes, native format | Optional **embed**, unmodified |
| ONLYOFFICE Developer Ed. | Commercial | — | same | + white-label | Yes | If a customer pays |
| Collabora Online / CODE | **MPL-2.0** | Docker 7 Nov 2026 | Linux/Docker only | iframe + WOPI (we write the WOPI host) | Yes (LibreOffice engine) | Licence-friendlier Linux **embed** |
| Univer | Apache-2.0 core; **xlsx import/export only in paid `@univerjs-pro`** (free tier: 10 exports/month, 3 collab connections) | 1.5.2, 16 Nov 2026 | Browser; Pro needs Node 22 server | Library | Only via Pro | Grid library only |
| Luckysheet / x-spreadsheet | MIT | last releases 2021 | — | — | No | Dead |
| Fortune-sheet | MIT | 1.0.4, Nov 2025 | Browser | Library | Own JSON | Slow activity |
| CryptPad / Etherpad | AGPL-3.0 / Apache-2.0 | active | Node servers | Separate apps | Own formats (CryptPad wraps ONLYOFFICE) | Skip |
| SheetJS CE | Apache-2.0 | **0.20.3 on cdn.sheetjs.com; npm `xlsx` stuck at 0.18.5 with two high advisories** | Library | Library | Data yes, styling limited | **Library** from CDN tarball |
| docx / docxtemplater / mammoth / PptxGenJS | MIT / MIT core / BSD-2 / MIT | 9.15.4 / 3.71.1 / 1.13.0 / 4.0.1 | Library | Library | Write docx / fill Word templates / docx→HTML / write pptx | **Library** |
| TipTap (ProseMirror) / Lexical | MIT / MIT | 3.34.0 / 0.53.0, Nov 2026 | Library | Library | No native docx | **Library** (TipTap) |
| Handsontable | **Non-commercial or paid; bans "competitive" software** | 18.1.2 | — | — | — | **Avoid** |
| AG Grid Community / Enterprise | MIT / Commercial | 36.3.0 | Library | Library | Excel export is Enterprise | Community OK |
| reveal.js / Slidev | MIT | 6.0.2 / 53.1.0 | — | — | No pptx | Not needed |
| Excalidraw / tldraw | MIT / **custom: production needs paid key, telemetry** | 0.18.1 / 5.6.1 | Library | Library | — | Excalidraw yes, tldraw **avoid** |

**What changed in 2026.**
- [ONLYOFFICE 9.4](https://www.it-connect.tech/onlyoffice-docs-9-4-drops-the-20-connection-limit-and-updates-its-open-source-license/) (May) **removed the Community Edition's 20-connection cap**.
- It also went single-process and dropped the RabbitMQ and database dependencies.
- In the same release it added terms to its AGPL licence that require derived versions to credit ONLYOFFICE. This followed the Euro-Office fork, and the [FSF has said](https://linuxiac.com/?p=210915) AGPL cannot be restricted that way, so the licence is now contested.
- Collabora's own staff say [CODE has had no document/connection limits since 2022](https://forum.collaboraonline.com/t/code-docker-limitations/810). It is still the unsupported build; paid support is suggested around 100+ users.

**Separate-process AGPL.** Running ONLYOFFICE or Collabora unmodified in its own process, reached only over HTTP/WOPI/iframe, is commonly treated as aggregation, so our code would not become AGPL/MPL. We would still have to:
- ship or offer the exact source of the build we distribute;
- keep its notices and branding;
- publish any changes we make to it.

MPL-2.0 is file-level copyleft and easier to live with. Not legal advice.

**Replicating it ourselves (estimates).**
- **Full Word/Excel/PowerPoint fidelity: don't.** Those layout engines represent more than a decade of work each.
- What a small manufacturer needs:

| Need | How | Effort |
|---|---|---|
| Quotes, POs and dispatch notes from their existing Word templates | docxtemplater | 1-2 weeks |
| Excel import/export | SheetJS 0.20.3 | days |
| Rich-text fields with docx export | TipTap + docx | 2-3 weeks |
| Previews of docx/xlsx/pdf | mammoth, SheetJS, pdf.js | 1 week |
| A spreadsheet-like grid on our existing Fx engine | AG Grid Community or our own grid | 6-10 weeks |

**Recommendation:** build the first four for the pilot. Offer "edit real Office files" as an optional add-on: ONLYOFFICE Community on Windows or Collabora CODE on Linux, installed by our installer, unmodified, behind our file store.

---

## 2. Team chat inside the app shell

| Project | Licence (verified) | Activity | Footprint | Embedding / SSO | Verdict |
|---|---|---|---|---|---|
| Matrix Synapse | AGPL-3.0 | 1.165.0, 10 Nov 2026 | Python + PostgreSQL ([SQLite not for production](https://element-hq.github.io/synapse/latest/setup/installation.html)); no native Windows | Own UI on `matrix-js-sdk` (Apache-2.0, 45.1.0); Element Web is AGPL | Too heavy |
| Continuwuity (conduwuit fork) | Apache-2.0 via conduwuit (**partly unverified**) | [v26.9.4, 14 Nov 2026](https://forgejo.ellis.link/continuwuation/continuwuity/releases) | Single Rust binary, RocksDB | Same SDK | Only if federation matters |
| Mattermost | Source AGPL-3.0; official binaries MIT | 12.1, Nov 2026 | Go + PostgreSQL | iframe; [SSO being removed from Team Edition; free "Entry" keeps 10,000 messages of history](https://docs.mattermost.com/product-overview/editions-and-offerings.html) | Poor free embed |
| Rocket.Chat | MIT outside `ee/` | very active | Node + MongoDB (**unverified**) | iframe auth; [Starter free ≤50 users with LDAP/SAML; Community ≤100 concurrent, "not suitable for production"](https://docs.rocket.chat/our-plans) | 50-user ceiling = our size |
| Zulip | Apache-2.0 | active | [Ubuntu/Debian only, ≥2 GB RAM](https://zulip.readthedocs.io/en/latest/production/requirements.html), Docker elsewhere | Separate app | Best design to learn from |
| Revolt → Stoat | AGPL-3.0 | [renamed Oct 2025](https://alternativeto.net/news/2025/10/chat-app-revolt-rebrands-to-stoat-keeps-all-services-features-and-core-values-unchanged) | Rust + MongoDB (**unverified**) | Discord-style | Skip |

Every server adds a second database and a second user directory. On Windows it also usually means Docker/WSL. For 50 users, chat is a modest feature on what we have: sessions, RBAC, `att_` attachments, MySQL.

**Build-it-ourselves scope (one developer, estimate):**

| Piece | Effort |
|---|---|
| Tables: channel, member, message (thread, edit, soft-delete), read pointer | 2 days |
| WebSocket on the Node server, authenticated by our session cookie; in-memory fan-out; SSE fallback | 4-5 days |
| Channels, DMs, group DMs, role-based membership | 4 days |
| Mentions, unread counts, in-app + Web Push notifications | 4-5 days |
| Files via the existing attachment store | 2 days |
| Presence and typing | 2 days |
| FULLTEXT search limited to the user's channels | 2-3 days |
| Record links and bot posts from flows/agents (our edge) | 3-4 days |
| UI | 8-10 days |
| **MVP total** | **~6-8 weeks** |

Out of scope: federation, E2E encryption, calls (link to Jitsi), native mobile push.

**Recommendation: build.** Take design ideas from Zulip (topics, unread model) and Mattermost (data model). Point customers who want a full chat product to Zulip or Rocket.Chat as a separate install.

---

## 3. Workflow and automation engines

| Project | Licence (verified) | Activity | Footprint | Verdict |
|---|---|---|---|---|
| **n8n** | **Sustainable Use Licence (fair-code)**: own internal business use only; distribution only free and non-commercial; `.ee.` files need an enterprise licence | 2.48.4, 13 Nov 2026 | Node | **Cannot ship in our product.** Design only |
| Node-RED | Apache-2.0 | 5.0.10, 17 Nov 2026 | Node, light; embeddable in Express | Possible **library** for "advanced flows"; good reference |
| Activepieces | MIT outside `packages/ee` | very active | [8 GB RAM + Postgres + Redis](https://www.activepieces.com/docs/install/configuration/hardware) | Design only; MIT pieces adaptable with attribution |
| Windmill | AGPL + proprietary CE; **licence says embedding in a distributable product needs a commercial licence** | active | Rust + Postgres | Avoid |
| Temporal / Trigger.dev | MIT / Apache-2.0 | 1.26.0 / 4.8.5, Nov 2026 | Server + DB (+ Redis, Docker) | Borrow ideas (durable steps, retries) |
| Kestra | Apache-2.0 | active | [Java 25, ≥4 GiB, 2 vCPU](https://kestra.io/docs/administrator-guide/requirements) | Too heavy |
| Automatisch | AGPL-3.0 (+ `.ee.` files) | last release 0.15.0, Aug 2025 | Node + Postgres + Redis | Skip |
| Camunda 7 CE | Apache-2.0, [**EOL Oct 2025**](https://wz-it.com/en/blog/camunda-7-end-of-life-operaton-cibseven-fluxnova-compared/); Apache-2.0 forks Operaton / CIB seven / Fluxnova | — | Java | Skip |
| Camunda 8 | **Camunda License 1.0**; [production needs a licence key since 8.6](https://docs.camunda.io/docs/8.7/reference/announcements-release-notes/860/860-announcements) | — | Java + Elasticsearch | Avoid |
| Flowable | Apache-2.0 | active | Java | Too heavy |
| bpmn-js | MIT **+ clause: bpmn.io watermark must stay visible** | 18.33.0 | Browser | Only if BPMN is ever needed |
| React Flow (`@xyflow/react`) | MIT | 13.0.2, 17 Nov 2026 | Browser | **Library** for the designer |
| Rete.js / Drawflow | MIT | Jun 2025 / Sep 2024 | Browser | Slower / stale |

**Recommended design: a small engine inside our server.**

1. **Definitions.** `ab_flow` holds a versioned JSON graph from the React Flow editor: trigger, actions, condition and loop nodes, with every property an Fx formula. Publishing makes an immutable version.
2. **Runs.** `ab_flow_run` (status, payload, `run_as_user_id`) plus `ab_flow_step` (input, output, error, attempt, duration). Together they are the run history and the audit trail.
3. **Queue.** Table: `ab_job(id, kind, payload, run_at, priority, status, attempts, max_attempts, locked_by, locked_until, last_error)`, indexed on `(status, run_at, priority)`.
   - Claim jobs with `SELECT … FOR UPDATE SKIP LOCKED`. This needs MySQL 8.0+ or [MariaDB 10.6+](https://code.djangoproject.com/ticket/32908).
   - On 10.4/10.5, claim with a conditional `UPDATE … WHERE id=? AND status='queued'` and check the affected-row count.
   - A sweeper re-queues expired locks. Retries use exponential backoff with jitter. Webhook triggers carry idempotency keys.
4. **Triggers.** Record created/updated/deleted (after commit), cron schedule (`node-cron`, ISC), webhook, button (Fx), chat message, agent request.
5. **Identity.** Each flow runs as its owner or a service account, through the same RBAC/RLS/CLS checks. Never superuser by default.
6. **Concurrency.** An in-process pool of about 4 workers is enough for 50 users. The table design allows a second worker process later.
7. **Approval step.** Parks the run (`waiting`) until a user approves in the app or chat. Agents reuse it.

Effort: engine + queue **3-4 weeks**, designer **2-3 weeks**, then connectors one by one. Skip BPMN.

---

## 4. AI agent builder ("minimal Copilot Studio")

### Hermes and Odysseus

**Hermes = [Nous Research's Hermes Agent](https://github.com/NousResearch/hermes-agent).**
- **MIT** (verified). Python 3.11-3.14, native Windows supported. Released Feb 2026; stable **v0.23.2 on 16 Nov 2026** ([releases.sh](https://releases.sh/nousresearch.md)).
- It is a personal, long-running agent you use from a terminal UI or from Telegram/Discord/Slack/WhatsApp/Signal through one gateway. It adds cron jobs, sub-agents, an MCP client, and six execution backends (local, Docker, SSH, Modal, Daytona, Vercel Sandbox).
- Architecture, per its [developer guide](https://hermes-agent.nousresearch.com/docs/developer-guide/architecture):
  - one `AIAgent` loop (`agent/conversation_loop.py`) shared by all entry points;
  - a self-registering tool registry (`tools/registry.py`) with per-platform "toolsets";
  - dangerous-command approval (`tools/approval.py`);
  - pluggable memory providers;
  - SKILL.md skills (agentskills.io format) that the agent writes itself;
  - lossy middle-turn compression;
  - a SQLite + FTS5 session store;
  - prompts built in stable → context → volatile tiers so provider prompt caching works.
- **Worth learning from (MIT, adaptable with attribution):** the registry/toolset pattern, the approval hook, the cache-friendly prompt layout, FTS5 recall and the compression policy. **Not for us:** self-written skills and open shell access. In a multi-user business app those are exactly the risks we must remove.

**Odysseus = PewDiePie's self-hosted "AI workspace"**, released June 2026.
- Repo [odysseus-dev/odysseus](https://github.com/odysseus-dev/odysseus), originally `pewdiepie-archdaemon/odysseus`. **AGPL-3.0-or-later** (verified).
- Stack: Python FastAPI + SQLAlchemy, a ChromaDB client and fastembed for RAG and memory. Installs with Docker Compose, plus a native Windows launcher.
- Features: chat + agents (tools, MCP, shell, skills, memory), a hardware-aware local-model "Cookbook", deep research, blind model comparison, an AI document editor, IMAP email, and notes/tasks/calendar.
- Its roadmap admits that tool schemas, skills and memory "eat the context" of small local models. That is a lesson for us.
- **AGPL, so design only.** Ideas worth taking: embedding-based tool selection, the hardware-aware model picker, and its auth-on defaults.
- Possible ambiguity: there is also an "odysseus" folder in `AI-Guru/ai_services` that I couldn't read. Please confirm the PewDiePie project is the one you meant.

### Frameworks and products

| Project | Licence (verified) | Latest | Verdict |
|---|---|---|---|
| Vercel AI SDK (`ai`) | Apache-2.0 | 7.0.176, 17 Nov 2026 | **Library (pick)**: streaming, tools, structured output, any OpenAI-compatible endpoint (HF router, OpenRouter, Ollama) |
| OpenAI Agents SDK | MIT | 0.22.0 | Alternative; pre-1.0 |
| LangGraph JS / LangChain JS | MIT | 1.7.5 / 1.6.6 | Usable, heavy abstraction |
| Mastra | Apache-2.0 **except `ee/` dirs** | 1.84.0, 17 Nov 2026 | OK if `ee` never imported |
| LlamaIndex TS | MIT | 0.12.1 (Dec 2025); core Mar 2026 | Activity slowed; skip |
| MCP TS SDK | v1 1.32.2 MIT; v2 `@modelcontextprotocol/server`/`client` 2.4.0 Apache-2.0 | Oct 2026 | **Library**, later phase |
| Flowise | Apache-2.0 except `enterprise/` (commercial) | 3.1.4, Jul 2026 | Design only |
| Dify | **Modified Apache-2.0: no multi-tenant use, keep frontend logo** | active | Avoid; AI competitor |
| Langflow | MIT | 1.13.3, 17 Nov 2026 | Design only (Python) |
| Open WebUI | **BSD-3 + clause: branding can't be removed above 50 users/30 days** without permission | 0.13.4 | Avoid in a product |
| AnythingLLM | MIT | active | Design reference |

### A minimal safe design under row/column security

An agent is an interface, not a principal. It never has more access than its caller.

1. **Identity.** Every tool call goes through Data API v1 code as `acting_user_id` (or the flow's run-as identity). RBAC, row filters and CLS apply unchanged. No raw SQL tool.
2. **Allow-listed tools.** A fixed catalogue: `search_records`, `get_record`, `propose_change`, `run_flow`, `search_documents`, `post_message`.
   - Makers choose the tables and columns for each tool.
   - The server intersects that choice with the caller's privileges at call time.
   - Schemas list only allowed fields, which also keeps context small.
3. **Writes need approval.** Write tools create a proposed change with a diff. The user approves it, then the server executes it as that user. Makers may auto-approve specific low-risk writes. Bulk changes always need approval.
4. **Prompt injection.** Cell values, document chunks, emails and chat messages are untrusted data.
   - Delimit and label them in the prompt.
   - Never let content change tools or identity.
   - No outbound HTTP/URL tool by default, so nothing can be leaked through a URL.
   - Render output with links and images disabled or proxied.
   - Approvals are the backstop: an injected instruction becomes a visible proposal.
5. **Data minimisation.** CLS-hidden columns never reach the model. A per-table "local model only" flag routes sensitive agents to on-prem Ollama.
6. **Limits.** Max steps per turn (e.g. 8), a row cap per tool result, timeouts, and per-user and per-org monthly cost caps.
7. **Audit.** `ab_agent_turn` records user, agent version, model and provider, tool calls with row ids, approvals and cost, in the same audit log as user writes.

Effort: runtime + tools + approvals + audit **4-5 weeks**; Studio agent designer **3 weeks**.

---

## 5. RAG on our stack

| Option | Licence | Facts (verified) | Verdict |
|---|---|---|---|
| **Embeddings as BLOB in MySQL/MariaDB + brute-force cosine in Node** | ours | Works on every DB version we support. 50k chunks × 384 dims ≈ 77 MB; a scan takes tens of ms (estimate) | **Pilot pick** |
| [MariaDB Vector](https://mariadb.com/docs/server/reference/sql-structure/vectors/vector-overview) | GPL-2.0 server (separate process) | `VECTOR(n)` + HNSW `VECTOR INDEX` from **11.7; 11.8 is the first LTS**. The index is used only for `ORDER BY VEC_DISTANCE_*() LIMIT k`; LIMIT applies before filters | **Upgrade path**; ship 11.8 LTS |
| [MySQL 9 VECTOR](https://dev.mysql.com/doc/refman/9.5/en/vector-functions.html) | GPL-2.0 | Community stores `VECTOR`, but **`DISTANCE()` is HeatWave/MySQL AI only**, not in Community or Commercial | Storage only; math in Node |
| sqlite-vec | MIT/Apache | 0.1.9, Mar 2026, pre-1.0 | Not needed |
| pgvector | PostgreSQL | — | Adds Postgres: no |
| LanceDB | Apache-2.0 | 0.41.0, in-process Node binding | Fallback above ~500k chunks |
| Qdrant / Chroma | Apache-2.0 | separate servers | Not for the pilot |

**Full-text and hybrid.**
- InnoDB `FULLTEXT` works on all our targets. Hindi and English tokenise on spaces.
- MySQL's ngram parser helps CJK. MariaDB has no built-in ngram parser as far as I found; [MDEV-10267](https://lists.mariadb.org/hyperkitty/list/developers@lists.mariadb.org/thread/HPD4BBVHRENWCBC6KLJY6RSX3FROJZJB) proposed one (status **unverified**).
- Hybrid search: run FULLTEXT top 50 and vector top 50 over the already permission-filtered set, then merge with Reciprocal Rank Fusion. Optionally rerank the top 20 with the LLM. This matters for part numbers and other jargon.

**Parsing (all verified):**

| Format | Library | Licence |
|---|---|---|
| PDF | `unpdf` 2.2.1 / `pdfjs-dist` 6.5 | MIT / Apache-2.0 |
| OCR (scans; run in the job queue) | `tesseract.js` 7.0.0 | Apache-2.0 |
| docx (keeps headings for chunking) | `mammoth` 1.13.0 | BSD-2 |
| xlsx | SheetJS 0.20.3 | Apache-2.0 |
| Everything else | `officeparser` 8.8.0 | MIT |

**Embedding models.**

| Model | Licence | Role |
|---|---|---|
| `multilingual-e5-small` (ONNX via `@huggingface/transformers` 4.3.2, Apache-2.0) | MIT | **Pilot pick**: CPU-friendly, multilingual |
| Qwen3-Embedding-0.6B | Apache-2.0 | Better quality, several times slower (estimate) |
| bge-m3 | MIT | Heavier, strong multilingual |
| EmbeddingGemma-300M | **Gemma terms, not OSI** | Check terms before shipping |

On 2 vCPU, expect roughly 20-50 chunks/s, so a 10k-chunk index takes minutes (**estimate; benchmark**). API embeddings work for customers who allow cloud.

**Chunking and permissions.**
- Chunk by structure: headings, ~400-800 tokens with ~15% overlap. Table rows become record chunks prefixed with the table and key columns.
- Store `source_id, row_id, acl_key, columns, text, embedding`.
- **Filter before retrieval:**
  - Rows: compute the user's allowed row set with the existing security engine and score only those rows. Build chunk text only from readable columns, either by storing per-column-set chunks or by rebuilding the text under CLS.
  - Documents: pre-filter on `acl_key`.
- Post-filtering a global top-k leaks ranking information and returns empty answers.
- With MariaDB HNSW, use a large k (e.g. 500) before filtering, or partition by `acl_key`.
- Re-index on record change via flow triggers.

---

## 6. LLM access and cost (prices on 18 Nov 2026)

**[Ollama Cloud](https://ollama.com/pricing):**

| Plan | Price | Included usage | Concurrent requests |
|---|---|---|---|
| Pay-as-you-go | $0 base, per-token | — | 3 |
| Pro | $20/month | $60/month | 3 |
| Max | $100/month | $300/month | 10 |
| Team (early access) | $500/month | $1,000 shared | 10 |

- Included usage doesn't roll over.
- Models: DeepSeek V4.x, GLM 5.x, gpt-oss, Kimi, MiniMax, Mistral Large 4, Nemotron, Gemma 4. **No Qwen on the cloud price list.**
- Examples per million tokens (input / output): gpt-oss:120b $0.15 / $0.60; glm-5.3-flash $0.15 / $0.50; deepseek-v4.1-flash $0.30 / $1.20 (half price off-peak); kimi-k3 $3 / $15.
- Data: Ollama states prompts and responses are "never logged or trained on". Hosting is mostly in the US with EU overflow, and GPU partners must keep zero retention.
- The same API runs locally, which makes it the natural on-prem path.

**[Hugging Face Inference Providers](https://huggingface.co/docs/inference-providers/pricing):**
- An OpenAI-compatible router (`router.huggingface.co/v1`) over about 20+ providers, passing their prices through with no markup.
- Credits: free accounts get none; PRO and Team/Enterprise seats get $2/month.
- [Security page](https://huggingface.co/docs/inference-providers/security): HF doesn't store request or response bodies; debug logs without user data are kept up to 30 days; each provider's own policy also applies.
- Rate limits are not stated (**unverified**).
- Live Qwen offers from `/v1/models`, per million tokens, tools flagged by the router (all these Qwen models are Apache-2.0):

| Model | Price (input / output) | Notes |
|---|---|---|
| Qwen3.6-35B-A3B | $0.10 / $0.90-0.95 (DeepInfra, Parasail) | |
| Qwen3.8-27B (Aug 2026) | $0.04-0.99 / $1.23-3.20 across ~20 providers; DeepInfra $0.15 / $1.875 | 262k context |
| Qwen3.5-9B | $0.10 / $0.15 | |
| Qwen3.5-122B-A10B | $0.29 / $2.40 | |

**Comparison:**

| Model | OpenRouter | Groq |
|---|---|---|
| Qwen3.8-27B | $0.06 / $2.20 | $0.80 / $4.00 (preview, "for evaluation") |
| Qwen3.6-35B-A3B | $0.10 / $0.90 | — |
| gpt-oss-120b | $0.15 / $0.60 | $0.15 / $0.60 |

OpenRouter's zero-retention options vary per provider (**unverified detail**).

**Tool-calling reliability.**
- [BFCL v4 via llm-stats](https://llm-stats.com/benchmarks/bfcl-v4) (updated 26 Oct 2026; **all scores self-reported**): Qwen3.5-397B 0.729, 122B-A10B 0.722, 27B 0.685, 35B-A3B 0.673, 9B 0.661.
- Roughly two in three multi-turn tool tasks succeed. That is fine for reads, not for unattended writes, hence approvals.
- Levers on our side: few tools, strict schemas, server-side validation with one retry, and our own 50-case regression suite per release.

**Cost per 1,000 agent turns (estimate).**
- Assumed turn: 3 calls × (6k input + 400 output) tokens, so 18M input + 1.2M output per 1,000 turns. Prompt caching lowers this further.

| Model / provider | Cost per 1,000 turns |
|---|---|
| Qwen3.6-35B-A3B on DeepInfra | **≈ $2.9** |
| gpt-oss-120b (Ollama/Groq) | ≈ $3.4 |
| Qwen3.8-27B on OpenRouter | ≈ $3.7 |
| Qwen3.8-27B on DeepInfra | ≈ $5.0 |
| deepseek-v4.1-flash on Ollama (peak) | ≈ $6.8 |
| Qwen3.5-122B on DeepInfra | ≈ $8.1 |
| Qwen3.8-27B on Groq | ≈ $19 |

- **30-user org:** 30 × 20 turns × 22 days ≈ 13,200 turns/month, so **≈ $40-110/month**, or about $250 on Groq speed. Indexing and background agents come on top. Ship cost caps anyway.

**Self-hosting on a rented GPU (estimate).**
- [RunPod](https://www.runpod.io/pricing) per hour: RTX 4090 $0.89, A6000 48 GB $0.69, L40S $1.09, A100 80 GB $1.19-2.19.
- `qwen3.6:35b-a3b` is 23 GB in Ollama, so it fits a 48 GB card.

| Scenario | Monthly cost | Break-even vs ~$3 per 1,000 turns |
|---|---|---|
| 24/7 | ≈ $500-800 | ≈ 170k-270k turns/month (13-20× our estimate) |
| Business hours only | ≈ $150-240 | ≈ 50k-80k turns/month |

- **APIs win for one customer.** Self-hosting is justified by data residency, or by a GPU shared across many customers.

**On-prem.** Ollama (MIT) as an optional component, with the AI SDK pointed at `localhost:11434/v1`.

| Hardware | Model | Notes |
|---|---|---|
| 12 GB GPU (e.g. RTX 3060) | `qwen3.5:9b` (6.6 GB, tools + vision) | |
| 24 GB GPU | `qwen3.6:35b-a3b` | |
| CPU with 32-64 GB RAM | the same MoE model | A few tokens/s (**estimate**) |

---

## 7. Dashboards and BI

| Project | Licence (verified) | Latest | Verdict |
|---|---|---|---|
| Recharts | MIT | 3.11.0, Nov 2026 | **Keep** (already in D5) |
| Apache ECharts | Apache-2.0 | 6.1.0, May 2026 | **Library** for rich/large charts |
| visx / Observable Plot | MIT / ISC | 4.0.0 / 0.6.19 | Optional |
| Metabase | **AGPL-3.0 + commercial `enterprise/`**; free guest embeds show "Powered by Metabase"; [interactive/SSO embedding and the React SDK are Pro/Enterprise](https://www.metabase.com/articles/is-metabase-embedding-free) | v0.65.5, Nov 2026 | **Don't embed** |
| Apache Superset | Apache-2.0 | 6.1.0, May 2026 | Too heavy (Python, Redis, metadata DB) |
| Evidence | MIT | active | Design reference |
| Cube | Apache-2.0 / MIT | active | **Design only**: copy measures/dimensions/pre-aggregations |

**Recommendation: build dashboards as Studio controls on server-side aggregates.**
1. A metric definition per table: dimensions, measures (sum/count/avg/distinct or an Fx expression), default filters.
2. `POST /api/v1/aggregate` compiles a small query AST into parameterised `GROUP BY` SQL **after the user's row filters**, and refuses CLS-hidden fields.
3. Results are cached per (metric, filters, security fingerprint) for 30-300 s.
4. Chart, KPI and pivot controls on Recharts/ECharts bind to it.

This also removes the D10 row-cap problem for dashboards. Effort: **3-4 weeks**.

---

## 8. External site / portal builder

| Project | Licence (verified) | Latest | Verdict |
|---|---|---|---|
| **Puck** (`@puckeditor/core`) | MIT | 0.24.0, Oct 2026 | **Library (pick)**: our controls become blocks; JSON page model |
| GrapesJS | BSD-3 (hosted Studio SDK is commercial) | 0.23.9, Nov 2026 | HTML-centric alternative |
| Craft.js | MIT | 0.2.12, Feb 2025 | Slowed; skip |
| Builder.io SDK | MIT SDK, **content in their SaaS** | 6.3.4 | Not on-prem |
| Payload | MIT | 3.94.0 | [MongoDB/Postgres/SQLite only, no MySQL](https://payloadcms.com/docs/v3/database/overview.md); reference |
| Strapi | MIT CE (outside `ee/`) | 5.62.0 | Reference; another app to run |
| Directus | **MSCL-1.0: no competing use**, becomes GPL-3.0 after 4 years | 41.0.1 | Competitor |

**Recommendation:** store Puck documents in `ab_portal_page` and render them server-side. External users get a "portal" role with its own row filters (e.g. own orders by contact email). Forms post through the Data API with captcha and rate limits. Effort: **4-6 weeks**.

---

## 9. Ops glue for a one-click install

| Need | Pick | Licence (verified) | Notes |
|---|---|---|---|
| HTTPS | **Caddy** v2.11.9 (4 Nov 2026) | Apache-2.0 | One binary for Windows and Linux; auto Let's Encrypt on a VPS. On a LAN, `tls internal` needs its CA trusted on clients |
| Windows service | **WinSW** or **Servy** | MIT / MIT | [NSSM's last release is 2014, pre-release 2017](https://nssm.cc/download). Servy's [comparison](https://dev.to/aelassas/servy-vs-nssm-vs-winsw-2k46) is by its own author |
| Process manager | not PM2 | **PM2 is AGPL-3.0** | Bundling it = distributing AGPL; use OS services + our own supervisor |
| Linux service | systemd | — | `Restart=always` |
| Packaging | **Native installers** on Windows (Inno Setup/WiX), tarball/.deb on Linux; Docker Compose optional on VPS | — | Docker Desktop needs WSL2 and has [subscription terms](https://docs.docker.com/subscription/desktop-license/) for companies ≥250 staff or ≥$10M revenue (**verify current**) |
| Database | Bundle **MariaDB 11.8 LTS** | GPL-2.0, separate process | Gives vectors + SKIP LOCKED. 10.4/10.5 are past EOL (**verify dates**). `mysql2` driver is MIT |
| Backup | `mariadb-dump`/`mysqldump` nightly + binlogs; `mydumper` (GPL-3.0) for big DBs; **restic** v0.19.1 (BSD-2) for encrypted off-site copies | separate binaries | Monthly test-restore from the admin page |
| Updates | Build: signed bundle, side-by-side `versions/x.y.z/`, pre-update backup, N-1-compatible migrations, health check, automatic rollback, offline update file | ours | ~2 weeks |

---

## (a) Bill of materials for the pilot

| Category | Pick | Licence | Footprint (estimate) |
|---|---|---|---|
| Office docs | SheetJS 0.20.3 (CDN), docxtemplater, docx, mammoth, TipTap; optional ONLYOFFICE (Win) / Collabora CODE (Linux) add-on | Apache / MIT / MIT / BSD-2 / MIT; add-on AGPL+terms / MPL-2.0 | Libraries in-process; add-on +1.5-2 GB |
| Chat | Build (WebSocket + MySQL FULLTEXT) | ours | +50-100 MB |
| Workflows | Build engine + MySQL queue; React Flow designer | ours / MIT | In-process |
| AI agents | Vercel AI SDK v7; MCP SDK later; our tools, approvals, audit | Apache-2.0 | Negligible |
| RAG | BLOB vectors + brute-force cosine + FULLTEXT hybrid; multilingual-e5-small; unpdf/mammoth/officeparser/tesseract.js | MIT / Apache / BSD-2 | 300-500 MB when model loaded |
| LLM | Qwen3.6-35B-A3B or Qwen3.8-27B via HF router/OpenRouter; gpt-oss-120b on Ollama Cloud as second source; on-prem Ollama + qwen3.5:9b | Apache-2.0 weights; Ollama MIT | On-prem: 12 GB+ GPU or 32 GB+ RAM |
| BI | Aggregate endpoint + Recharts/ECharts controls | MIT / Apache-2.0 | In-process |
| Portal | Puck + portal role | MIT | In-process |
| Ops | Caddy, WinSW / systemd, MariaDB 11.8, dump + binlog + restic, own updater | Apache / MIT / GPL (separate) / BSD-2 | Caddy ~30-50 MB |

**RAM, core install:**

| Component | RAM |
|---|---|
| Node server (API, sockets, workers) | 400-600 MB |
| Embedding model | 300-500 MB |
| MariaDB with 1 GB buffer pool | 1.3-1.6 GB |
| Caddy | ~50 MB |
| OS | 400-600 MB |
| **Total** | **≈ 2.5-3.4 GB** |

That fits a **4 GB VPS**. With the office add-on, plan **8 GB**. All estimates; measure on the pilot box.

## (b) Licence risk table

Not legal advice.

| Component | Licence | Risk if shipped in our product | Use |
|---|---|---|---|
| n8n, NocoDB | Sustainable Use (fair-code) | **Prohibited** | Design only / competitor |
| Windmill | AGPL + proprietary CE, embedding needs a commercial licence | **High** | Avoid |
| Directus | MSCL (no competing use) | **High** | Avoid |
| Camunda 8 | Camunda License 1.0 | **High** | Avoid |
| tldraw | Custom, paid production key, telemetry | **High** | Excalidraw |
| Handsontable | Non-commercial / paid, no competing software | **High** | AG Grid Community / own grid |
| NocoBase | Apache-2.0 + terms (keep branding, no public low-code/AI SaaS) | High | Competitor |
| Dify | Modified Apache (no multi-tenant, keep logo) | Medium-high | Avoid |
| Open WebUI | BSD-3 + branding clause above 50 users | Medium-high | Avoid |
| Univer Pro | Commercial (free: 3 connections, 10 exports/month) | Medium (cost) | Apache core only |
| ONLYOFFICE Docs | AGPL-3.0 + contested terms | Medium: separate unmodified process with source offer | Optional add-on |
| Synapse, Dendrite, Stoat, CryptPad, ToolJet, Automatisch, Odysseus, Metabase | AGPL-3.0 | High inside; medium as separate process | Design only / separate tool |
| PM2 | AGPL-3.0 | Medium (redistribution) | WinSW / systemd |
| Mattermost | AGPL source / MIT binaries | Medium | Separate tool |
| Budibase, ERPNext | GPL-3.0 | High inside | Competitors |
| bpmn-js | MIT + mandatory watermark | Low | If BPMN ever |
| Mastra, Flowise, Rocket.Chat, Activepieces, Strapi, Baserow | Permissive outside `ee/`/`enterprise/`/`premium/` | Low if those paths are never imported | CI lint |
| EmbeddingGemma | Gemma terms | Low-medium | Prefer MIT/Apache models |
| `xlsx` 0.18.5 from npm | Apache-2.0 | **Security**: two high advisories | Use 0.20.3 CDN build |
| MariaDB/MySQL, mydumper | GPL | Low as separate processes | Never link GPL client libs |

Add a CI check: an allow-list of MIT/Apache/BSD/ISC (MPL by exception) dependencies, plus a grep for `/ee/`, `.ee.`, `enterprise/` and `@univerjs-pro`.

## (c) Direct competitors

**Blunt finding:** for an Indian small manufacturer, [ERPNext](https://github.com/frappe/erpnext) (GPL-3.0, free, Indian-built, MariaDB-based) already covers well over 70% of what the pilot apps would do:
- BOMs, work orders and job cards; stock, purchasing, sales and accounts;
- workflows, print formats, web forms, a customer portal and dashboards;
- GST through the community "India Compliance" app (**unverified detail**).

Its base, the [Frappe Framework](https://github.com/frappe/frappe), is **MIT** and is itself a metadata-driven low-code platform: DocTypes ≈ our tables, with roles, permissions and workflows. Odoo Community (LGPL-3.0) is the other "already done" answer; its Studio builder is Enterprise-only (**unverified**).

| Product | Licence (verified) | What it already does that we plan to build |
|---|---|---|
| ERPNext / Frappe | GPL-3.0 / MIT | Manufacturing ERP, DocType builder, workflows, forms, portal, reports |
| Odoo Community | LGPL-3.0 | MRP, inventory, website builder, chat, automation rules |
| NocoBase | Apache-2.0 + terms | Plugin low-code platform, row/field permissions, workflows, ["AI employees" since 2.0](https://www.nocobase.com/fr/highlights/ai-employee): **closest to the whole suite idea** |
| Budibase | GPL-3.0 (+BSL pro) | Apps + automations + RBAC; [2026 roadmap](https://budibase.com/blog/updates/future-of-budibase-2026/): data-scoped AI agents with RBAC, human-in-the-loop, private LLMs, which is almost exactly our section 4 |
| Appsmith | Apache-2.0 CE | Drag-and-drop internal apps on any DB, JS, Git sync |
| ToolJet | AGPL-3.0 | Apps, workflows, built-in DB, AI app generation |
| Baserow | MIT core | Airtable-style DB + app builder + automations |
| NocoDB | Sustainable Use | Spreadsheet UI over MySQL/Postgres |
| Directus | MSCL | Instant API + admin over existing SQL, flows, dashboards |

**Real differentiation, strongest first:**
1. **The Power Apps-style formula canvas.** Every property is an Excel-style formula. None of the above has it: they use JavaScript, handlebars or Python. This suits Excel-literate office staff and is our one distinct asset.
2. **A native Windows single install that works offline**, with data files as first-class sources. Competitors mostly assume Docker on Linux.
3. **Security that AI inherits.** Agents, RAG, dashboards and chat all sit on one RLS/CLS engine with write approvals. Budibase is heading the same way, so this must ship early and be easy to demonstrate.
4. **Price, Hindi/English and local support** for Indian SMBs. ERPNext partners compete here too.

"We also have chat, docs, BI and a portal" is **not** a differentiator. These are commodities, and nine categories would spread two people thin. Make points 1 and 3 excellent, keep chat/flows/BI thin on the shared security engine, and for the manufacturer integrate with ERPNext through a REST connector rather than rebuilding manufacturing modules.

---

## Sources

**Licence files and repositories:** [n8n](https://github.com/n8n-io/n8n/blob/master/LICENSE.md) · [Node-RED](https://github.com/node-red/node-red/blob/main/LICENSE) · [Activepieces](https://github.com/activepieces/activepieces/blob/main/LICENSE) · [Windmill](https://github.com/windmill-labs/windmill/blob/main/LICENSE) · [Kestra](https://github.com/kestra-io/kestra/blob/master/LICENSE) · [Automatisch](https://github.com/automatisch/automatisch/blob/main/LICENSE) · [Trigger.dev](https://github.com/triggerdotdev/trigger.dev/blob/main/LICENSE) · [Temporal](https://github.com/temporalio/temporal/blob/main/LICENSE) · [Camunda 7](https://github.com/camunda/camunda-bpm-platform/blob/master/LICENSE) · [Camunda License 1.0](https://github.com/camunda/camunda/blob/main/licenses/CAMUNDA-LICENSE-1.0.txt) · [Flowable](https://github.com/flowable/flowable-engine/blob/main/LICENSE) · [bpmn-js](https://github.com/bpmn-io/bpmn-js/blob/main/LICENSE) · [xyflow](https://github.com/xyflow/xyflow/blob/main/LICENSE) · [ONLYOFFICE DocumentServer](https://github.com/ONLYOFFICE/DocumentServer) · [Collabora Online](https://github.com/CollaboraOnline/online/blob/main/COPYING) · [Univer](https://github.com/dream-num/univer/blob/main/LICENSE) · [Fortune-sheet](https://github.com/ruilisi/fortune-sheet/blob/master/LICENSE) · [CryptPad](https://github.com/cryptpad/cryptpad/blob/main/LICENSE) · [Etherpad](https://github.com/ether/etherpad-lite/blob/master/LICENSE) · [SheetJS](https://git.sheetjs.com/sheetjs/sheetjs) · [Handsontable](https://github.com/handsontable/handsontable/blob/master/LICENSE.txt) · [tldraw](https://github.com/tldraw/tldraw/blob/main/LICENSE.md) · [Excalidraw](https://github.com/excalidraw/excalidraw/blob/master/LICENSE) · [Synapse](https://github.com/element-hq/synapse/blob/master/LICENSE-AGPL-3.0) · [conduwuit](https://github.com/girlbossceo/conduwuit/blob/main/LICENSE) · [Mattermost](https://github.com/mattermost/mattermost/blob/master/LICENSE.txt) · [Rocket.Chat](https://github.com/RocketChat/Rocket.Chat/blob/master/LICENSE) · [Zulip](https://github.com/zulip/zulip/blob/main/LICENSE) · [Stoat](https://github.com/stoatchat/stoatchat/blob/main/LICENSE) · [Hermes Agent](https://github.com/NousResearch/hermes-agent) · [Odysseus](https://github.com/odysseus-dev/odysseus) · [Dify](https://github.com/langgenius/dify/blob/main/LICENSE) · [Open WebUI](https://github.com/open-webui/open-webui/blob/main/LICENSE) · [Flowise](https://github.com/FlowiseAI/Flowise/blob/main/LICENSE.md) · [Langflow](https://github.com/langflow-ai/langflow/blob/main/LICENSE) · [AnythingLLM](https://github.com/Mintplex-Labs/anything-llm/blob/master/LICENSE) · [Mastra](https://github.com/mastra-ai/mastra/blob/main/LICENSE.md) · [Ollama](https://github.com/ollama/ollama/blob/main/LICENSE) · [Metabase](https://github.com/metabase/metabase/blob/master/LICENSE.txt) · [Superset](https://github.com/apache/superset/blob/master/LICENSE.txt) · [Evidence](https://github.com/evidence-dev/evidence/blob/main/LICENSE) · [Cube](https://github.com/cube-js/cube/blob/master/LICENSE) · [Puck](https://github.com/puckeditor/puck/blob/main/LICENSE) · [GrapesJS](https://github.com/GrapesJS/grapesjs/blob/master/LICENSE) · [Builder.io](https://github.com/BuilderIO/builder/blob/main/LICENSE) · [Payload](https://github.com/payloadcms/payload/blob/main/LICENSE.md) · [Strapi](https://github.com/strapi/strapi/blob/main/LICENSE) · [Directus](https://github.com/directus/directus/blob/main/license) · [NocoDB](https://github.com/nocodb/nocodb/blob/master/LICENSE.md) · [Baserow](https://github.com/bram2w/baserow/blob/master/LICENSE) · [Appsmith](https://github.com/appsmithorg/appsmith/blob/master/LICENSE) · [ToolJet](https://github.com/ToolJet/ToolJet/blob/main/LICENSE) · [Budibase](https://github.com/Budibase/budibase/blob/master/LICENSE) · [NocoBase](https://github.com/nocobase/nocobase/blob/main/LICENSE.txt) · [ERPNext](https://github.com/frappe/erpnext/blob/develop/license.txt) · [Frappe](https://github.com/frappe/frappe/blob/develop/LICENSE) · [Odoo](https://github.com/odoo/odoo/blob/master/LICENSE) · [Caddy](https://github.com/caddyserver/caddy/blob/master/LICENSE) · [PM2](https://github.com/Unitech/pm2/blob/master/GNU-AGPL-3.0.txt) · [WinSW](https://github.com/winsw/winsw/blob/master/LICENSE.txt) · [Servy](https://github.com/aelassas/servy) · [restic](https://github.com/restic/restic/blob/master/LICENSE) · [mydumper](https://github.com/mydumper/mydumper/blob/master/LICENSE) · [pgvector](https://github.com/pgvector/pgvector/blob/master/LICENSE) · [Qdrant](https://github.com/qdrant/qdrant/blob/master/LICENSE) · [Chroma](https://github.com/chroma-core/chroma/blob/main/LICENSE) · [MariaDB server](https://github.com/MariaDB/server/blob/main/COPYING)

**Documentation, pricing and news:**
- Office: [ONLYOFFICE 9.4 (EN)](https://www.it-connect.tech/onlyoffice-docs-9-4-drops-the-20-connection-limit-and-updates-its-open-source-license/), [(FR)](https://www.it-connect.fr/onlyoffice-docs-9-4-decouvrez-les-nouveautes/) · [FSF on ONLYOFFICE](https://linuxiac.com/?p=210915) · [ONLYOFFICE editions](https://www.onlyoffice.com/compare-editions) · [ONLYOFFICE Windows install](https://helpcenter.onlyoffice.com/docs/installation/docs-community-install-windows.aspx) · [Collabora CODE limits](https://forum.collaboraonline.com/t/code-docker-limitations/810) · [Univer Pro](https://docs.univer.ai/guides/sheets/getting-started/pro) · [Univer import/export](https://docs.univer.ai/guides/sheets/features/import-export) · [Univer server](https://docs.univer.ai/server/requirements) · SheetJS advisories [GHSA-4r6h-8v6p-xvw6](https://github.com/advisories/GHSA-4r6h-8v6p-xvw6), [GHSA-5pgg-2g8v-p4x9](https://github.com/advisories/GHSA-5pgg-2g8v-p4x9)
- Chat: [Synapse install](https://element-hq.github.io/synapse/latest/setup/installation.html) · [Continuwuity releases](https://forgejo.ellis.link/continuwuation/continuwuity/releases) · [Mattermost editions](https://docs.mattermost.com/product-overview/editions-and-offerings.html) · [Rocket.Chat plans](https://docs.rocket.chat/our-plans) · [Zulip requirements](https://zulip.readthedocs.io/en/latest/production/requirements.html) · [Stoat rename](https://alternativeto.net/news/2025/10/chat-app-revolt-rebrands-to-stoat-keeps-all-services-features-and-core-values-unchanged)
- Workflows: [Activepieces hardware](https://www.activepieces.com/docs/install/configuration/hardware) · [Kestra requirements](https://kestra.io/docs/administrator-guide/requirements) · [Camunda 7 EOL and forks](https://wz-it.com/en/blog/camunda-7-end-of-life-operaton-cibseven-fluxnova-compared/) · [Camunda 8.6 licence key](https://docs.camunda.io/docs/8.7/reference/announcements-release-notes/860/860-announcements) · [SKIP LOCKED on MariaDB 10.6+](https://code.djangoproject.com/ticket/32908)
- Agents: [Hermes architecture](https://hermes-agent.nousresearch.com/docs/developer-guide/architecture) · [Hermes releases](https://releases.sh/nousresearch.md) · [Odysseus overview](https://www.mindstudio.ai/blog/what-is-odysseus-pewdiepie-open-source-ai-workspace)
- RAG: [MariaDB vector](https://mariadb.com/docs/server/reference/sql-structure/vectors/vector-overview) · [MySQL vector functions](https://dev.mysql.com/doc/refman/9.5/en/vector-functions.html) · [MariaDB ngram proposal](https://lists.mariadb.org/hyperkitty/list/developers@lists.mariadb.org/thread/HPD4BBVHRENWCBC6KLJY6RSX3FROJZJB)
- LLM: [Ollama pricing](https://ollama.com/pricing) · [HF pricing](https://huggingface.co/docs/inference-providers/pricing) · [HF security](https://huggingface.co/docs/inference-providers/security) · [HF router models](https://router.huggingface.co/v1/models) · [OpenRouter models](https://openrouter.ai/api/v1/models) · [Groq models](https://console.groq.com/docs/models) · [BFCL v4](https://llm-stats.com/benchmarks/bfcl-v4) · [RunPod](https://www.runpod.io/pricing)
- BI, portal, ops, competitors: [Metabase embedding](https://www.metabase.com/articles/is-metabase-embedding-free) · [Payload databases](https://payloadcms.com/docs/v3/database/overview.md) · [Docker Desktop licence](https://docs.docker.com/subscription/desktop-license/) · [NSSM downloads](https://nssm.cc/download) · [Servy comparison](https://dev.to/aelassas/servy-vs-nssm-vs-winsw-2k46) · [Budibase 2026](https://budibase.com/blog/updates/future-of-budibase-2026/) · [NocoBase AI employees](https://www.nocobase.com/fr/highlights/ai-employee)
- Package metadata: registry.npmjs.org, pypi.org, hub.docker.com, proxy.golang.org, huggingface.co/api (queried 18 Nov 2026).
