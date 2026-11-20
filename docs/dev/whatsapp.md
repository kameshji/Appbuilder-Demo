# WhatsApp connector (developers)

P2 package E, exit check 6. Meta WhatsApp Business Cloud API through the [connector actions framework](connectors.md#connector-actions):
template messages and session replies, an opt-in store per environment, an inbound webhook, a message log and the
`whatsapp` notification channel. No unofficial APIs. Administrator view: [WhatsApp](../admin/whatsapp.md); maker view:
[WhatsApp in flows](../guide/maker/whatsapp.md).

This software records consent and refuses to send without it. It does not make a business compliant with WhatsApp's
policies or any law: the business is responsible for the consent being real and for getting its templates approved by
Meta. Legal questions are for a lawyer.

## Files

| File | What |
| --- | --- |
| `server/core/whatsapp/ddl.ts` | Tables of schema version 13 (independent step), `upgradeEnvironmentTo13Whatsapp` |
| `server/core/whatsapp/defs.ts` | The five action definitions (pure data; also read by `npm run docs:gen` through `actions/builtin-defs.ts`) |
| `server/core/whatsapp/provider.ts` | The `ActionProvider` of kind `whatsapp`: settings check, connection test, `invoke`, template listing |
| `server/core/whatsapp/send.ts` | **The** send path (`sendMessage`): opt-in, 24-hour window, idempotency, the call, the log |
| `server/core/whatsapp/graph.ts` | Graph API client over `actions/outbound.ts`, fixed base address, error mapping, `setGraphBaseForTests` |
| `server/core/whatsapp/phone.ts` | E.164 normalisation with the connection's default country code; masking |
| `server/core/whatsapp/store.ts` | Opt-ins and history, message log, windows, keywords, notification mapping, people's choices |
| `server/core/whatsapp/webhook.ts` | `GET/POST /api/v1/whatsapp/webhook/:env/:connectionId` |
| `server/core/whatsapp/routes.ts` | Admin API (opt-ins, import, history, message log, settings) and `/whatsapp/me` |
| `server/core/whatsapp/channel.ts` | The notification channel and its job `whatsapp.notify` |
| `server/core/whatsapp/index.ts` | `wireWhatsapp` (called from `actions/wiring.ts`), retention job `whatsapp.retention` |
| `server/core/whatsapp/mock-graph.ts` | Fake Graph API and webhook payload builders (tests and the exit check only) |
| `src/portal/AdminWhatsapp.tsx`, `WhatsappConnectionFields.tsx`, `WhatsappNotificationChoice.tsx`, `whatsappApi.ts` | Admin console > WhatsApp, the connection form part, the Settings > Notifications column |

Edits outside the folder (small, additive): `actions/wiring.ts` (wiring), `actions/builtin-defs.ts` (reference list),
`actions/service.ts` (`ProviderCall.source` / `correlationId`), `actions/http.ts` (Meta's host reserved),
`actions/solution-parts.ts` (`PACKAGE_CONNECTORS`), `notifications-delivery.ts` (`addChannel`, `updateLog`),
`server/routes/meta/connections.ts` (`KINDS`, `ACTION_KINDS`), `src/platform/contracts.ts` (`ConnectorKind`),
`src/portal/Connections.tsx`, `ConnectionBits.tsx`, `NotificationChannels.tsx`, `Admin.tsx`.

## Connection

Kind `whatsapp`, actions only (no tables). Settings: `phoneNumberId`, `businessAccountId`, `apiVersion` (default
`v21.0`), `defaultCountryCode` (required; the form suggests `91`), `sendingEnabled` (default true), `inboundFlowId`
(optional), `perMinute` (60), `maxConcurrent` (4). Secret (sealed JSON): `{ accessToken, appSecret, verifyToken }`;
replacing the secret replaces all three parts (like HTTP connections). `secrets()` returns all three, so the framework
redacts them from outputs, errors and the activity log.

**No base address.** `graph.ts` always calls `https://graph.facebook.com/<version>/...` with an allow-list of exactly that
host, no redirects, private networks refused, TLS verified, through `safeRequest` (pinned DNS answers). `checkSettings`
refuses any setting whose name contains url, base, host or endpoint. Tests replace the address in-process with
`setGraphBaseForTests(url)` (the same kind of injection as `setLookupForTests`); nothing reads it from settings, the
process environment or a request.

**Meta's hosts are reserved.** `actions/http.ts` refuses every host of `facebook.com`, `facebook.net`, `fb.com`,
`fbcdn.net`, `fbsbx.com`, `whatsapp.com` and `whatsapp.net` (Meta serves the Graph API under more than one name, such as
`b-graph.facebook.com`), and wildcards that cover one, on HTTP connections when they are saved, and drops them from older
connections' allow-lists at call time. Otherwise an HTTP connection with a token could send messages without the opt-in
check. Not covered: an IP address of Meta written as the host (with TLS verification on, its certificate does not match),
and anyone who holds the access token outside Appbuilder.

## Actions

Generated reference: [connector actions](../reference/connector-actions.md) (run `npm run docs:gen` after changing
`defs.ts`).

| Action | Side effect | Notes |
| --- | --- | --- |
| `sendTemplate` | external, not idempotent | `to`, `template`, `language` (default `en`), `bodyParams`, `headerParams`, `buttonParams` |
| `sendText` | external, not idempotent | Only inside the 24-hour window as this server knows it |
| `listTemplates` | none | Reads every page of the account's templates (at most 1,000) |
| `checkOptIn` | none | `optedIn`, `status`, `source`, `recordedOn`, masked number |
| `recordOptIn` | none | `status`, `source` (form, import; not administrator, and not inbound keyword, which only the webhook records when the person writes the keyword), `evidence` (at least 10 characters) |

Template values may be text, numbers or formula records `{ Value }` (a flow's `["a", "b"]`). Meta's rules are checked
before sending: no empty values, no new lines or tabs, at most four spaces in a row, at most 1,024 characters.

## Opt-in enforcement

`sendMessage` (`send.ts`) is the only code that posts to `/<phone number id>/messages`. The actions `sendTemplate` and
`sendText` (flows, table events `RunConnector`, the Test action form: all through `services.actions.run`) and the
notification channel's job call it. In order:

1. the connection is a WhatsApp connection with `sendingEnabled` not `false` and a phone number id;
2. the number is normalised to E.164;
3. an idempotency key that already has Meta's message id in the log returns that message (`replayed`) without sending;
4. **the opt-in store must say `opted_in` for that number now**; otherwise `denied` and a `refused` row in the log;
5. `sendText` only when the log of inbound messages (`ab_whatsapp_windows`) has a message from that number to that
   WhatsApp number in the last 24 hours; otherwise `denied` with the reason;
6. the log row `sending` (unique per connection and idempotency key), the call, then `accepted` with Meta's id or `failed`
   with the error (the key is released so a retry makes a new attempt).

The opt-in check is per environment and per number, not per connection. Session replies need an opt-in too (stricter
than WhatsApp's own rule: a person writing to you is not recorded as consent unless they send a START keyword or you
record it).

The test "refuses to send to a number without a current opt-in, by every route" in `whatsapp.integration.test.ts` tries
`services.actions.run` (template and text), the Test action route, a flow's `action` step, `sendMessage` directly (the
channel's way in), the notification channel, an opted-out number and an HTTP connection to Meta's host.

## Idempotency (at least once)

Flows pass `<run id>:<step key>` to every side effect. Two layers keep a retry from sending twice: the framework's
`ab_action_idempotency` (24 hours) and the message log's unique `(connection_id, idempotency_key)` with Meta's message id
(as long as the log row is kept). Meta's API has no idempotency key of its own: when the network fails after Meta
accepted a message but before the answer arrived, the attempt is logged as failed and a retry sends again. That window
cannot be closed on our side.

## Errors

`mapGraphError` turns Meta's `{ error: { code, error_subcode, ... } }` into plain-English `OutboundError`s: expired or
revoked token (190, 401: `not_configured`), missing permission (10, 200-299, 403: `denied`), rate limits (4, 80007,
130429, 131056, 613, 429: `rate_limited`, retryable, with `Retry-After` when sent), spam limit (131048), template missing
or not approved (132001), paused or disabled (132015, 132016), wrong number of values (132000, 132012), person stopped
marketing messages (131050), per-person marketing limit (131049), outside 24 hours (131047), number cannot receive
(131026, 133010, 131030, 131021), invalid value (100, 131008, 131009), account restricted (368, 131031), Meta's service
(131000, 131016, 1, 2, 5xx: retryable). Meta's own message text is not passed on (it can quote request values).

## Webhook

See [the administrator page](../admin/whatsapp.md#webhook). Verification handshake (GET, verify token compared in
constant time), `X-Hub-Signature-256` (HMAC-SHA256 of the raw body with the app secret, constant time, required), a
512 KB body limit, 600 calls a minute per connection, replay marks (SHA-256 of the signature, 8 days; a repeat answers 200
`duplicate` without effect, because Meta re-sends deliveries it thinks failed), events older than 7 days ignored, events of
another phone number id ignored. Statuses move the log forward (`sending < accepted < sent < delivered < read`, `failed`
always wins; every status is kept in `history`). Inbound messages are logged without their text, open the 24-hour window,
and the configurable STOP / START keywords opt the number out / in (a STOP always applies; a START only when the message
is newer than the current record, so a delayed or replayed START never undoes a later opt-out).

**Flow trigger.** When the connection has `inboundFlowId`, each inbound message calls `services.flows.triggerWebhook`
with `Body = { From, Name, Type, Text, MessageId, SentOn, Keyword, Connection }` and delivery id `wa:<message id>` (the
flow must have a webhook trigger; one run per message id). This reuses the existing webhook trigger: no new trigger type.

## Notification channel

`channel.ts` registers with `DeliveryService.addChannel`. For each notification it checks, in the notification's
environment: the person chose WhatsApp for the kind (`ab_whatsapp_prefs`, off by default); a mapping exists
(`ab_whatsapp_settings.notifications`: connection, template, language, which of title / body / link fill the body values;
the template is checked against Meta when saved: approved, same language, same number of values); the connection has a
secret and sending on; the person's profile phone normalises; the number has a current opt-in. Then a `whatsapp.notify`
job (key `wa-notify:<notification>:<user>`) sends through `sendMessage` (key `notify:<notification>:<user>`), at once or
when the person's do-not-disturb hours end. No digest. The delivery log row (`channel = 'whatsapp'`) goes `queued` ->
`sent` / `failed` / `skipped` with the reason. Locks of the administrator's notification policy do not apply to WhatsApp.

## Message log and numbers

`ab_whatsapp_messages`: direction, number, kind, template and language, status and history, Meta's message id,
idempotency key, source (`flow:<id>`, `notification:<kind>`, `test`, `webhook`), action run id, correlation id,
notification id, user, error. **No message text** (not the template values, not replies, not inbound text). Kept 90 days
(`whatsapp.retention`, built-in schedule, `days` 7 to 3650). Opt-ins and their history are never deleted by it.

Numbers are stored in plain E.164 (the opt-in check and inbound matching need exact numbers; the database and backups are
protected like the rest of the data). Only environment administrators see full numbers (Admin console > WhatsApp and its
API). Everything else shows the masked form `+91 •••••••001`: action outputs (so flow run history), the activity log of
actions, error messages, audit entries, Settings > Notifications.

## Environments and solutions

None of the WhatsApp tables are copied into a new environment (`environment-ops.ts` `COPY_META` does not list them), so a
copy arrives with no opt-ins (and none of their evidence), no message log, no notification mapping and no choices; its
WhatsApp connections lose their secrets like every connection (status not configured, webhook refuses calls), and its
flows are off. A test environment therefore cannot message real customers until an administrator enters a token and
records opt-ins there. A solution may carry a WhatsApp connection (settings only, never secrets).

## Tests

`whatsapp.test.ts` (no database) and `whatsapp.integration.test.ts` (PostgreSQL, the fake Graph API; the flow exit check
runs the real engine). `scripts/exit-check/p2-whatsapp.mjs` runs the exit check against a real server.

### The fake Graph API: documented versus assumed

Nothing in `mock-graph.ts` was recorded from a real account (none exists). Taken from Meta's public Cloud API
documentation as known to the author: the endpoints and methods, the request body of template and text messages
(`messaging_product`, `recipient_type`, `to`, `type`, `template.name`, `template.language.code`, `components` with `header`,
`body`, `button` and `sub_type` / `index`), the response `{ messaging_product, contacts: [{ input, wa_id }], messages: [{ id }] }`,
the templates list `{ data: [{ name, language, status, category, id, components }], paging: { cursors, next } }`, the error
envelope and the codes listed above, the webhook envelope (`object`, `entry[].changes[].field = "messages"`, `value.metadata`,
`statuses[]` with `id`, `status`, `timestamp`, `recipient_id`, `errors[]`, and `messages[]` with `from`, `id`, `timestamp`,
`type`, `text.body` / `button`), `X-Hub-Signature-256` and the `hub.*` handshake. Assumed: the exact form of message ids,
`paging` cursors as numbers, which HTTP status accompanies each error code, whether `Retry-After` is ever sent, the
`conversation` / `pricing` values, the phone number fields returned by `GET /<phone number id>`.

### To confirm with a real Meta account (unverified)

- The default API version `v21.0` is accepted, and the request bodies above are accepted as sent (for example `to`
  without `+`, `index` as text, quick-reply payload buttons).
- The HTTP status and error codes Meta actually returns for: expired token, template not approved / paused, wrong
  number of values, invalid number, rate limits (and whether `Retry-After` is sent), 131047, 131050.
- Webhook signature over the exact raw bytes Meta sends; the handshake parameters; how often and with what delay Meta
  retries a delivery; whether a retried delivery has the same body and signature (the replay rule relies on it).
- Status ordering in practice (late `delivered` after `read`), `failed` error details, and that `metadata.phone_number_id`
  is always present.
- Template list paging and the `components` shape for headers with media.
- Throughput and rate limits for a new number; the quality rating field of the connection test.
