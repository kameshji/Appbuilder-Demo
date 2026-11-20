# Realtime: live data refresh, presence and notifications

P0 package H. One WebSocket per browser tab, `/api/v1/live` on the same HTTP server and port as the API. It carries
"table changed" ticks (so every open data table, gallery, chart and label refreshes when someone else changes data),
presence (who else has an app or a record open), the Studio's soft edit lock, app and environment change messages, and
the signed-in user's in-app notifications. Chat (P3) will run on the same connection.

| File | What it does |
| --- | --- |
| `src/platform/live-protocol.ts` | The protocol: message types, topics, close codes, limits, notification settings. Shared by server and browser (server rules: no React, no DOM, erasable TypeScript). |
| `server/core/live/hub.ts` | The hub: upgrade checks, connections, subscriptions, the leak rule (`tableMessageFor`), presence, Studio locks, limits, heartbeat. |
| `server/core/live/changes.ts` | The table change feed: `bridgeOutbox` turns committed outbox rows (package G) into table changes; `noteLocalWrite` records the writer and the live connection of a request. |
| `server/core/live/session-events.ts` | Session revocation feed: wraps `MetaStore.sessions.remove/removeForUser` and `users.remove`. |
| `server/core/live/wiring.ts` | Successful write requests (`router.onMutation`) -> `app:<id>` and `env` messages. |
| `server/core/notifications.ts`, `notifications-ddl.ts` | Notification store (`ab.notifications`, `ab.user_settings`), the `notify()` service, the HTTP API. |
| `src/platform/live.ts` | `LiveClient`: the browser's connection (reconnect, resubscribe, gap detection, degraded state). |
| `src/platform/remote-live.ts` | Server mode glue: pushes -> query-cache invalidation, workspace reloads, unread count; `platform.live`, `platform.notifications`. |
| `src/platform/demo-live.ts` | Demo mode: the same API over a `BroadcastChannel` between tabs of one browser. |
| `src/platform/useLive.ts` | React hooks: `usePresence`, `useLiveTopic`, `useLiveStatus`. |

## Protocol (version 1)

Every message is one JSON text frame with a type `t`. Binary frames close the socket (4400).

Client to server:

| Message | Meaning |
| --- | --- |
| `{ t: 'sub', id?, topic, env? }` | Subscribe. `env` is required for every topic except `user:<me>`. Answer: `subscribed` (with `seq` for table topics and the server `epoch`) or `error`. |
| `{ t: 'unsub', id?, topic, env? }` | Unsubscribe. |
| `{ t: 'presence', scope, env, state }` | Join a presence scope (`viewing` or `editing`) or leave it (`null`). Same permission as subscribing to `presence:<scope>`. |
| `{ t: 'lock', id?, scope: 'studio:<appId>', env, action }` | Studio soft lock: `acquire`, `release`, `takeover`. Answer: `lock { ok, holder, mine, message? }`. |
| `{ t: 'ping', id? }` | Application ping (latency); answer `pong`. The WebSocket ping/pong keeps the socket alive. |

Server to client: `hello` (first message: protocol version, server `epoch`, this connection's id, the user, limits),
`subscribed`, `unsubscribed`, `error { code, message }`, `pong`, `resync`, `lock`, and the topic messages:

| Topic | Message | Who may subscribe |
| --- | --- | --- |
| `table:<tableId>` | `table { seq, prev, op, rows, columns, by?, at, self? }` | Users who may read the table (others: `not-found` or `denied`) |
| `user:<userId>` | `user { event: 'notification' \| 'unread' \| 'session', ... }` | Only the user themself (install-wide, no environment) |
| `presence:app:<appId>` | `presence { members }` | Users who may run the app (and makers) |
| `presence:studio:<appId>` | `presence { members, lock }` | Makers |
| `presence:record:<tableId>:<rowId>` | `presence { members }` | Users who may read the table |
| `presence:online` | `presence { members }` (who has a socket open) | Administrators; lists only users who may enter that environment |
| `env` | `env { kind: 'metadata' \| 'security' \| 'state' \| 'deleted', locked? }` | Anyone who may enter the environment |
| `app:<appId>` | `app { kind: 'saved' \| 'renamed' \| 'deleted', by, modifiedOn? }` | Users who may run the app (and makers) |

`self: true` marks a message caused by this socket's own write: the browser sends its connection id in the
`X-Appbuilder-Live` header on every write; the router keeps it with the request, `noteLocalWrite` maps the request id to
it, and the outbox row carries the request id. The client skips refetching for its own changes (already applied).

Close codes: 1001 server stopping, 1009 message too large, 4400 not protocol, 4401 no session or the session ended,
4403 password change required, 4408 slow consumer (resync), 4429 too many connections or messages.

### Sequences, gaps and resync

`seq` of a table message is the **outbox id** of the change (package G's `ab_outbox`: per environment, increasing, and per
table in commit order). `prev` is the seq of the previous change of the same table that this server delivered. The client
keeps the last seq per table topic:

- a message whose `prev` is not the last seen seq means a gap: the topic gets `{ t: 'resync' }`;
- after a reconnect, the `subscribed` answer carries the table's latest seq; if it differs from the last seen one, changes
  were missed: resync;
- a different `epoch` in `hello` (the server restarted) resyncs every topic.

Resync means: invalidate that table's cached queries and reload its small-table cache. The client never applies row
values from a message; it always refetches through the secured query path, so a missed message costs one refetch, never
wrong data. A server that was down catches up the same way (subscribers that need the missed rows themselves can read
them with `services.kernel.outbox.read(afterId)`).

Changes that do not go through the DataService (an administrator's "assign owner" on a table) are emitted directly and
reuse the latest seq of the environment.

## Security rules

**Upgrade.** Same Host and Origin allow-list as HTTP (`originProblem`, DNS rebinding). An `Origin` header is required and
must be this origin. This is the CSRF-equivalent check for WebSockets: a cross-site WebSocket hijacking attack needs a page
on another site, and browsers always send that page's Origin on a WebSocket handshake (scripts cannot change it); the
session cookie is also `SameSite=Strict`. Programs outside a browser can send any Origin, but they would need the session
cookie, which is HttpOnly. Then the session cookie decides: none, expired, disabled account: accepted then closed with
4401 (the browser cannot read an HTTP status from a failed handshake, a close code it can); forced password change: 4403.

**Every subscription names its environment** and is checked with the same function as HTTP requests
(`userContextFor`: 404 unknown environment, 403 no access). Security contexts are cached per socket and environment for
10 seconds and dropped at every security change (`security.invalidate`), after which every subscription is checked again
and the ones no longer allowed are ended. Only a refusal (401, 403, 404) ends a subscription; a check that could not be done (the database, an environment being restored: 503) keeps it and is tried again 5 seconds later and then with every minute's sweep until it succeeds (finding P2-3 of `docs/internal/security-review-p2.md`: before, it waited for the next security change, and presence messages are not re-checked per message).

**The leak rule for table messages** (`tableMessageFor`, unit-tested in `server/core/live/hub.test.ts`, end to end in
`server/core/live.integration.test.ts` and `scripts/docs-shots/live.mjs`):

1. A subscriber without read privilege on the table gets no message at all.
2. `columns` lists only changed column NAMES whose access for the subscriber is not `none`; `id` is never listed. Values
   are never sent.
3. `rows` (row ids) are sent only to subscribers whose read access covers every row of the table (administrators, or a
   role with scope "all" and no row filter), and only up to 50 ids. Everyone else gets `rows: null`: a "table changed"
   tick, and refetches through the secured query path. We do not evaluate per-row visibility per subscriber on every write:
   that would cost a query per subscriber per change; a tick plus a refetch is safe and cheap enough.
4. `by` (who changed it) comes only together with row ids.

**Presence** goes only to people who may run the app (app scopes), makers (Studio scopes), readers of the table (record
scopes) or administrators (online). A user who switches on "Hide my presence" (Settings > Notifications, stored on the
server) is left out of every list; as a Studio lock holder they show as "Another maker".

**Session ends close sockets at once**: logout, password change (every other device), an administrator disabling or
deleting the account or resetting its password. The `user:<me>` topic gets a `session` event first (`signed_out`,
`password_changed`, `password_change_required`, `disabled`, `removed`, `expired`), then the socket closes with 4401. A
sweep re-checks every socket's session once a minute (sessions that vanished another way).

## Limits and backpressure

| Limit | Default | Setting |
| --- | --- | --- |
| Sockets per user (all tabs and devices) | 20 | `APPBUILDER_LIVE_MAX_PER_USER` |
| Sockets per server | 5,000 | `APPBUILDER_LIVE_MAX_CONNECTIONS` |
| Subscriptions per socket | 200 | |
| Inbound message size | 16 KB (close 1009) | |
| Inbound rate | burst 60, 20 per second (errors, then close 4429) | |
| Outbound buffer per socket | 1 MB: above it the socket gets `resync` and is closed with 4408 (never unbounded buffering) | |
| Heartbeat | WebSocket ping every 25 s; a socket that missed the previous pong is terminated | |
| Row ids per table message | 50 (above: `rows: null`) | |

Compression (permessage-deflate) is off: messages are small, and compression costs CPU and opens decompression-bomb risks.

## The browser side

`LiveClient` (one per tab) connects after sign-in, reconnects with exponential backoff and full jitter (1 to 30 seconds; at
least 30 seconds after a 4429), immediately when the tab becomes visible or the browser comes back online, and not at all
while the browser is offline. After 4 seconds without an open socket its state is **degraded**: the page refreshes every
table it reads every 30 seconds and the top bar shows "Live updates paused" (with the reason). When the socket is back the
page refreshes once to catch up.

Table messages are coalesced per table (120 ms quiet, at most 800 ms late) and then invalidate the table's cached queries
(`QueryCache.invalidateTable`: watched entries refetch while their previous rows stay on screen, so there is no flicker and
scroll positions stay) and reload its small-table cache. The client subscribes to a table's topic the first time the page
reads the table (at most 150 table topics per tab).

Forms (`src/controls/inputs/Form.tsx`) follow their record by id. A record changed elsewhere while the form has no unsaved
edits simply reloads; with unsaved edits the form shows "This record was changed by <name>" with **Reload** and **Keep
mine** instead of overwriting the edits. The form also sends the version it started from (`modifiedOn`) with the save
(`PATCH /data/:table/rows/:id` with `ifModifiedOn`); a stale save answers 409 and opens the same panel. See data-api.md.

The Studio (`src/studio/live.tsx`): the first maker who opens an app holds the edit lock; others open it read-only (the
canvas, properties and formula bar ignore edits: `StudioState.readOnly`) and see the holder's saves as they happen; "Take
over editing" moves the lock (the previous editor becomes read-only and is told). A lock outlives its holder's socket by 10
seconds, so a reload keeps it. Without a live connection the lock cannot be checked: the Studio stays editable and says so.

Demo mode: `demo-live.ts` gives the same API over a `BroadcastChannel` named `appbuilder-demo-live`: a tab that saved rows or
an app tells the other tabs, which re-read them from browser storage; notifications are kept in browser storage; presence
uses a heartbeat every 10 seconds. There are no locks in demo mode.

### Chat on the same connection (P3 package E)

Chat no longer opens a socket of its own: `src/chat/store.ts` takes the page's `LiveClient` (`pageLiveClient()` in
`remote-live.ts`) and subscribes `chat:<id>`, `chat:typing:<id>` and `user:<me>` on it. What the client does for that:

- `chat` and `typing` messages are routed to the handlers of their topic (no `env`: chat topics are install-wide);
- the `subscribed` answer of a chat topic is delivered to its handlers (with `seq`, the conversation's `LastSeq`), instead
  of the table-style resync; a new server `epoch` still sends every topic, chat included, a `resync`;
- `unsubscribed` (the server ended a subscription) and an `error` that answers a `sub` (matched by its id) reach the
  topic's handlers;
- `resetEnvTopics()` (an environment switch, called by `remote-live.ts` `envChanged()`) drops environment-bound topics,
  presence and locks only; install-wide topics and topics subscribed with `{ keep: true }` (a chat card's record table in
  another environment) stay; `resetTopics()` (sign-out) still drops everything; `user:<me>` is not unsubscribed and
  subscribed again on a switch;
- the browser's `offline` event closes the socket at once (status degraded "You are offline."), so a cut network shows
  at once; `online` reconnects;
- `drop()` (tests and exit checks: a network cut) and `serverEpoch()`.

Tests: `src/chat/socket.test.ts` (the routing chat needs), `src/platform/live.test.ts` (unchanged behaviour).

## Scaling limits

The hub is in the server process: subscriptions, presence, locks, sequences and the "last writer" memory live in memory.
One Node process serves every socket; there is no fan-out between processes (decision D19). Measured in the sandbox
(2 vCPU Xeon 2.1 GHz, PostgreSQL on the same machine, `scripts/load/live-load.mjs`): 300 sockets on one table, 50 row
updates per second through the HTTP API for 30 seconds: every one of the 450,000 messages delivered, latency from sending
the write to receipt p50 15 ms, p95 37 ms, p99 80 ms (max 165 ms) (includes the HTTP write, the commit and the outbox dispatch), server
CPU 44 % of one core, memory 185 MB before and 198 MB at most.

## Wiring for other packages

- Row changes reach the hub only through the outbox (`bridgeOutbox` in `app.ts`); a new write path that writes outbox rows
  is pushed automatically. A write that bypasses the outbox calls `emitTableChange()`.
- `services.notifications.notify({ userIds, teamIds }, { kind, title, body?, link?, environmentId?, source, from? })`
  stores and pushes notifications (since P1 also by email, as digests, with quiet hours: the delivery module decides the
  channels per kind and recipient, see [notifications-delivery.md](notifications-delivery.md)) (package G's NotifyUser uses kind `event`). `teamIds` (team ids or codes) resolve to the
  members of teams of that environment or install-wide teams (`app.ts` registers the resolver over `ab.teams` and
  `ab.team_members`); a team notification needs `environmentId`.
- The chat module gets the connection through `ChatPanel`'s `live` prop or `useChatLive()` (`src/chat/live.ts`).
