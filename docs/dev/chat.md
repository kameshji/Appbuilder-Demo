# Chat (server and protocol)

Chat is one per install: channels, direct conversations and group conversations, with threads, reactions, files, cards,
mentions, search, retention, moderation and an audited export. This page is the contract package B (the chat UI) builds
on. Administrators: [chat for administrators](../admin/chat.md). Design decisions: [p3-spec.md](../plan/p3-spec.md)
sections 2 and 5.1 to 5.9.

| File | What |
| --- | --- |
| `src/platform/chat-protocol.ts` | Shared shapes: conversations, messages, cards, changes, live messages, limits, emoji, topic helpers |
| `src/platform/system-tables.ts` | The four communication tables and their policy `chat` (`chatRead`) |
| `server/core/chat/service.ts` | The chat service: the only writer of the chat tables |
| `server/core/chat/routes.ts` | HTTP routes, the live access check, the digest relevance check, the retention job |
| `server/core/chat/admin.ts` | Settings, metadata, moderation, reports, export, retention |
| `server/core/chat/cards.ts` | Cards resolved per reader |
| `server/core/chat/format.ts` | Body sanitising, mentions, cards shape, search query |
| `server/core/chat/settings.ts` | `ab.settings` key `chat`; environment delete and copy hooks |
| `server/core/chat/ddl.ts` | Schema version 14 (`ab_chat_reports`, `ab_chat_exports`) and the extra indexes |
| `server/core/live/hub.ts` | The chat topics |
| `server/core/chat/discussions.ts` | Package E: the Discussions list (record discussions = Comments), read markers |
| `server/core/approvals/chat-hook.ts` | Package E: approval cards (the sweep, the per-reader resolver) and the timeline event per answer |
| `src/chat/share.tsx`, `src/chat/cards/ApprovalCard.tsx`, `src/chat/Discussions.tsx`, `src/chat/mentions.ts` | Package E: "Share to chat", approval cards, the Discussions list, chat mentions on the Mentions page |

Not built: email of chat items beyond the existing digest, presence dots in direct conversations (decided in package E:
not built, see "Presence" below), offline sending (chat sending needs a connection), answering approvals by typing or by
replying to an email, a policy-level switch for approval cards.

## Where chat lives

- **The chat environment**: one environment holds chat's rows, files and backups (install setting `chat.environmentId`,
  default `default`). It can be changed only while chat holds no messages. Every chat route works from any environment:
  the server resolves the chat environment itself (the `X-Appbuilder-Environment` header is ignored by chat routes).
- **Who may use chat**: every active person with access to the chat environment, and install administrators. Not API
  keys (`Authorization: Bearer` is refused with 403), not service accounts.
- **Administrators of chat**: administrators of the chat environment (environment administrators there, install
  administrators). Moving chat to another environment: install administrators.

## Data model

The four communication system tables of the chat environment (stable ids = physical names):

| Table | Columns added by package A | Notes |
| --- | --- | --- |
| `sys_channels` (Channels) | `DirectKey`, `LastSeq`, `LastMessageOn`, `PurgedSeq`, `PostingPolicy`; `Kind` gains `group` | `Kind` channel / direct / group (`record` reserved). `IsPrivate` false = open channel. `DirectKey` = the two user ids sorted, joined by `:` (unique: one 1:1 per pair). `LastSeq` = the change counter. `PurgedSeq` = changes up to it were removed by retention. |
| `sys_channel_members` (Channel members) | `LastReadSeq`, `NotifyLevel` (all / mentions / none), `JoinedOn` | `MemberRole` member / owner; `Muted`. Unique (Channel, User). |
| `sys_messages` (Messages) | `Seq`, `ChangeSeq`, `Kind` (message / system), `BodyText`, `Cards`, `Files`, `MentionIds`, `ReplyCount`, `LastReplyOn`, `DeletedBy` | Unique (Channel, Seq). `ParentMessage` = thread root (one level). For system messages `Cards` holds `{"event": {...}}`. `MentionIds`: JSON list of user ids, plus `"channel"` for @channel. |
| `sys_message_reactions` (Message reactions) | none | Unique (Message, owner, Emoji); 12 emoji (`CHAT_EMOJI`). |

Also: Mentions gain a `Message` lookup (a chat mention is a Mentions row with `regardingTable = sys_messages`,
`regardingId` = the message); Follows gain `LastReadOn` (for package E). Metadata tables (schema version 14, environment
schema): `ab_chat_reports` (message, channel, reporter, reason, state open / handled, outcome, handled by / on) and
`ab_chat_exports` (channel, reason, by, on, SHA-256 of the download token, expiry, counts). Indexes:
`ab_ix_chat_msg_history` (Channel, Seq DESC), `ab_ix_chat_msg_changes` (Channel, ChangeSeq), `ab_ix_chat_msg_replies`,
`ab_ix_chat_msg_fts` (GIN on `to_tsvector('simple', BodyText)`), `ab_ux_chat_direct_key`, `ab_ix_chat_member_user`,
`ab_ix_chat_reaction_msg`.

Environment copies never take chat (the four tables, chat files, chat mentions); solutions never contain chat data; the
environment data export and a backup's table browser leave chat out; deleting the chat environment is refused while it
holds messages.

## Security

The policy `chat` (`chatRead` in `src/platform/system-tables.ts`) compiles to one condition in the statement, the same for
everyone **including administrators** (no `TRUE` for them):

- Channels: `id IN (Channel of my membership rows) OR (Kind = 'channel' AND IsPrivate = false AND ArchivedOn IS NULL)`;
- Channel members and Messages: rows of a readable channel; Message reactions: rows of a readable message;
- Mentions and Attachment links about a message: the message's rule (for administrators too);
- create, update, delete, share: false for everyone (`systemCanCreate` is false). The chat service writes with its own
  checks.

So Query v2, the data API, CSV export, dashboards, print templates, reporting views and flows read chat only as far as
membership allows. The live table and record topics on the four tables are refused for everyone (chat has its own
topics). The chat service applies the same rule: a conversation the reader may not read answers **404 "Conversation not
found."**, exactly like one that does not exist (messages: "Message not found.").

## HTTP API

All under `/api/v1`, a signed-in person (cookie; `X-Appbuilder: 1` on writes), JSON. Errors are the usual
`{ error: { code, message, field? } }` (422 invalid with a readable reason, 403 denied, 404 not found, 409 conflict,
429 rate limited). Chat routes are data routes: a locked production environment does not block them. Types are in
`src/platform/chat-protocol.ts`.

### Me

| Route | Answer |
| --- | --- |
| `GET /chat/me` | `{ id, name, environmentId, isAdmin, readOnly, readOnlyReason: 'install' \| 'chat' \| null, canCreateChannels, limits: CHAT_LIMITS, emoji: CHAT_EMOJI }` |

### Conversations

| Route | Body | Answer |
| --- | --- | --- |
| `GET /chat/conversations` | | `{ items: ChatConversation[] }` my conversations, latest message first, with `unread` and `mentions` |
| `GET /chat/conversations?browse=1` | | open channels I have not joined |
| `POST /chat/conversations` | `{ kind: 'channel' \| 'direct' \| 'group', name?, description?, isPrivate? (default true), members?: userIds, postingPolicy?: 'everyone' \| 'owners' }` | `ChatConversation`. direct: exactly one other person; the same pair always gets the same conversation. group: 3 to 8 people. channel: a name (unique among channels not archived; 409); the creator is an owner. |
| `GET /chat/conversations/:id` | | `ChatConversation` |
| `PATCH /chat/conversations/:id` | `{ name?, description?, postingPolicy? }` | `ChatConversation` (owners of a channel; any member of a group; not direct). Privacy is fixed at creation. |
| `POST /chat/conversations/:id/join` | | open channels |
| `POST /chat/conversations/:id/leave` | | `{ left }` (not direct; the last owner leaving makes the longest member an owner) |
| `POST /chat/conversations/:id/archive` | `{ archived }` | owners of a channel, members of a group; archived = read-only, and an archived open channel is members only |
| `PATCH /chat/conversations/:id/me` | `{ notifyLevel?: 'all' \| 'mentions' \| 'none', muted? }` | `ChatConversation` (my own settings; not a change of the conversation) |
| `GET /chat/conversations/:id/members` | | `{ items: ChatMemberView[] }` |
| `POST /chat/conversations/:id/members` | `{ userIds, role?: 'member' \| 'owner' }` | `{ items }`. Private channels: owners; open channels and groups: members; never direct. |
| `PATCH /chat/conversations/:id/members/:userId` | `{ role }` | owners (a channel keeps one owner) |
| `DELETE /chat/conversations/:id/members/:userId` | | `{ removed }` owners; the person's subscriptions end at once |
| `GET /chat/conversations/:id/mentionable?q=` | | `{ users: [{ id, name }] }`: members, or every chat user you may see in an open channel |
| `GET /chat/people?q=` | | `{ users }` chat users you may see (the environment's directory visibility applies) |

### Messages

| Route | Body | Answer |
| --- | --- | --- |
| `GET /chat/conversations/:id/messages?before=<seq>&after=<seq>&limit=50` | | `{ messages: ChatMessageView[], more, lastSeq, purgedSeq }`: top-level messages (thread replies are not in it), oldest first; `before` pages back, `after` forward; at most 100 |
| `GET /chat/conversations/:id/messages?around=<seq>&limit=50` | | `{ messages, more, newer, lastSeq, purgedSeq }`: one page around an old message (the message and older ones, then newer ones); `more` = older exist, `newer` = newer exist. Deep links use it instead of paging back. |
| `POST /chat/conversations/:id/messages` | `{ body, parent?, files?: attachmentIds, cards?: ChatCardRef[], clientId? }` | `{ message, duplicate }`. `clientId` (8 to 80 of `A-Za-z0-9_.:-`) makes a retried send find the first message (`duplicate: true`): send it on every message. |
| `GET /chat/messages/:id/replies?after=&limit=` | | `{ root, messages, more }` |
| `PATCH /chat/messages/:id` | `{ body }` | `{ message }` (own messages; "edited") |
| `DELETE /chat/messages/:id` | | `{ deleted }` (own messages; a "message deleted" line stays) |
| `POST /chat/messages/:id/reactions` | `{ emoji, on? (default true) }` | `{ message }` |
| `POST /chat/messages/:id/report` | `{ reason }` | `{ reported }`: administrators are told that a report waits |
| `GET /chat/conversations/:id/changes?after=<seq>` | | `ChatChanges`: every message whose latest change is after `after` (deleted ones too), the conversation, the members when a member change happened; `reset: true` when `after < purgedSeq` (reload the latest page); `more: true` when the answer is one full page (`CHAT_CHANGES_PAGE`, 1,000): ask again after the last `changeSeq` it carries |
| `POST /chat/conversations/:id/read` | `{ seq }` | `{ lastReadSeq, unread, mentions }`; also marks this conversation's chat mentions and chat notifications up to `seq` read and pushes `chat.unread` to my other tabs |
| `POST /chat/conversations/:id/typing` | | `{ ok }` (at most one event per person and conversation every 3 s) |
| `POST /chat/cards/resolve` | `{ messageId, index }` | `ChatCardView` |
| `GET /chat/search?q=&channel=&from=&before=&page=` | | `{ items: [{ message, conversation: { id, kind, name } }], more }`, 20 per page |
| `GET /chat/mentions?limit=` | | `{ items: [{ id, IsRead, createdOn, Body, Link, byName, conversation, regardingTable, regardingId }] }`: where I was mentioned in chat (the chat environment, from any environment), messages I can still read only; `Link` = `#chat?c=..&m=..` (the Mentions page opens it) |
| `POST /chat/mentions/:id/read` | | `{ ok }` (my own chat mentions only) |
| `GET /chat/discussions?limit=` | | `{ items: DiscussionItem[] }`: see "Record discussions". Runs in the **request's** environment (send `X-Appbuilder-Environment`), unlike the other chat routes |
| `POST /chat/discussions/read` | `{ table?, row }` | `{ ok, following }`: my Follows row's `LastReadOn` = now (the timeline calls it when a followed record's timeline loads) |

**Message format.** `body` is the comment rich-text subset (`RICH_TEXT_TAGS`), sanitised on the server; mentions are
`<span data-mention="<userId>">@Name</span>` and `<span data-mention="channel">@channel</span>` (people in channels up to
50 members; above, owners and administrators). The server takes mentions from the body only. **A mention of someone who
cannot read the conversation is refused (422) with the reason**; in an open channel every chat user can be mentioned.
Limits: 4,000 characters of text (20,000 of stored rich text), 10 files, 3 cards of at most 6 fields, 30 messages a
minute per person.

**Files.** Upload first, then name the ids in the message:

| Route | Body | Answer |
| --- | --- | --- |
| `POST /chat/conversations/:id/files?name=<file name>` | the file (raw body, `Content-Type` of the file) | `ChatFile` without `url` (a draft). Over 25 MB: 413, from `Content-Length` before the body is read. |
| `DELETE /chat/files/:id` | | a draft I uploaded |

A draft must be named in a message by its uploader, in the same conversation, within an hour; it can be named once.
Sent files are served by the existing `GET /api/v1/attachments/:id?env=<chat environment>` (in `ChatFile.url`), whose
check is the message's read rule: a non-member gets the same 404 as for a missing attachment. Drafts older than a day
are removed by the retention job; unsent drafts older than an hour by the orphan sweep at start.

**Cards** (`ChatCardRef`): `{ kind: 'record', env, table, row, fields }`, `{ kind: 'app', env, app, screen? }`,
`{ kind: 'dashboard', env, dashboard }`. Stored as references; `POST /chat/cards/resolve` resolves one per reader in its
environment: no access to the environment, the table, the row (or the row is deleted or in the recycle bin) → `{
available: false, kind }` (the same answer for hidden and missing); a record shows the chosen fields minus every column
the reader may not read (the names are not sent either), the primary column as `title` only when readable; an app when
the reader may run it; a dashboard's title and description when the reader may view it. Chat tables are never cards.
Re-resolve a record card when the record's table topic ticks for the reader.

**Approval cards** (package E): `{ kind: 'approval', env, request, assignment, state: 'pending' | 'done' }`. Only the
system sender posts them (`parseCards` refuses the kind from people): one per pending assignment of the current stage,
in the person's direct conversation with "Approvals" (`DirectKey` = `system:approvals:<userId>`, one member,
`system: 'approvals'` on `ChatConversation`, `canPost` false; sends, reactions, reports and deletes there are refused).
The message has no sender, `Kind = message` (it counts as unread) and the text "Approval needed: <title>". Resolved per
reader by `server/core/approvals/chat-hook.ts` through the approvals service's own `detail()` AS THE READER (`canSee`;
the record only as the reader may read it): `ChatApprovalCardView` (title, status, outcome, requester, due, the declared
fields, options with `requireComment`, `canDecide`, `myAnswer`). Answers go to `POST /approvals/:id/respond` (with the
card's environment in `X-Appbuilder-Environment`), the inbox's route and checks. The sweep (a worker tick hook, at most
every second per environment) posts cards for new assignments (delegation, reassignment and escalation make new ones) and
sets `state: 'done'` when an assignment is no longer waiting (answered anywhere, decided, cancelled, reassigned), which is
an `edit` push: open cards resolve again. Message ids are derived from (environment, assignment)
(`approvalCardMessageId`), so a card is posted once across retries, restarts and workers. A person gets no cards when
they cannot use chat or have approval notifications in the app switched off (`kinds.approval === false`).

## Record discussions

A record's discussion IS its Comments (spec default 5; no channel of kind `record`). The record timeline UI component
(`src/controls/display/collab.tsx`) shows them with: mentions limited to readers of the record (the composer and the edit
box use `/collab/mentionable`), **editing one's own comment** (the server's existing rule: update = about the record AND
written by me; `EditedOn` set, mentions re-extracted; no history kept, as for chat messages), "Share to chat", live
updates (the collaboration tables' topics), a read marker (`POST /chat/discussions/read` when a followed record's
timeline loads) and an extension point for other modules' composer actions (`addTimelineAction`, e.g. Notes' "New note").
Replies to a comment (`ParentComment`) are not shown as threads: the spec asks for one thread per record.

`GET /chat/discussions` (`DiscussionItem`: `table, row, tableName, label, following, mentioned, lastCommentOn,
lastText, lastBy, unread, link`) lists the records I follow (Follows, owner = me) and the records where a comment
mentioned me, read through the DataService AS ME: the regarding rule hides comments, mentions and follows of records I
cannot read, and a record without a readable label is left out. `unread` = comments by others after my
`Follows.LastReadOn` (following) or after my unread mention; `link` = the newest comment's `Link` (the app it was
written in, `#u-<app>?record=<id>`), or null. Leak tests: `chat-security.integration.test.ts` "record discussions"
and "losing read access loses the discussion".

### Administrators (`/chat/admin/*`)

| Route | Body | Answer / audit |
| --- | --- | --- |
| `GET /chat/admin/settings` | | `{ environmentId, createChannels, retention: { channel, direct, group }, readOnly: [{ id, name }], canChangeEnvironment, messages }` |
| `PUT /chat/admin/settings` | `{ createChannels?: 'everyone' \| 'makers', retention?: { channel?, direct?, group? } (days, at least 30, or null), environmentId? (install administrators, only while chat is empty) }` | `chat.settings` |
| `POST /chat/admin/readonly` | `{ userId, readOnly }` | `chat.readonly` |
| `GET /chat/admin/channels?q=&kind=&offset=` | | `{ items: [{ id, kind, name, description, isPrivate, archived, lastMessageOn, createdOn, createdBy, members, messages, openReports }], more }` (never message text) |
| `GET /chat/admin/channels/:id/members` | | `{ items }` |
| `POST /chat/admin/channels/:id/archive` | `{ archived }` | `chat.channel.archive` |
| `DELETE /chat/admin/channels/:id/members/:userId` | | `chat.member.remove` |
| `DELETE /chat/admin/channels/:id` | `{ confirm }` (the channel's name, or "delete" for direct and group) | deletes it with its messages and files; `chat.channel.delete` |
| `POST /chat/admin/messages/:id/moderate` | `{ note? }` | removes the body and files; `chat.message.moderate` (channel and message id, never text). A system line (members, archive, export) answers 422: it cannot be removed (P3 review, P3-11) |
| `GET /chat/admin/reports?state=open\|handled\|all` | | `{ items }` with the reported message's text |
| `POST /chat/admin/reports/:id` | `{ action: 'delete' \| 'dismiss' }` | `chat.report.handle` |
| `POST /chat/admin/channels/:id/export` | `{ reason }` (at least 10 characters; recent sign-in needed) | `{ id, url, expiresOn }`; a system message tells the members; `chat.export` (with the reason) |
| `GET /chat/admin/exports` | | `{ items }` |
| `GET /chat/admin/exports/:id/download?token=` | | ZIP: `transcript.html` and `files/` (only the exporting administrator, for an hour); `chat.export.download` |
| `POST /chat/admin/retention/run` | | runs retention now; `chat.retention.run` |

## Live protocol

On the existing connection ([live.md](live.md)); protocol version 1, nothing existing changed. Chat topics are
install-wide: subscribe **without `env`**.

| Topic | Message | Who |
| --- | --- | --- |
| `chat:<channelId>` | `ChatPushMessage`: `{ t: 'chat', topic, channelId, seq, prev, op: 'message' \| 'edit' \| 'delete' \| 'reaction' \| 'members' \| 'channel', message?, at, self? }` | readers of the conversation |
| `chat:typing:<channelId>` | `ChatTypingMessage`: `{ t: 'typing', topic, channelId, userId, name, at }` (never to the typer) | readers |
| `user:<me>` | `{ event: 'chat.unread', channelId, lastSeq, lastReadSeq?, unread?, mentions? }` (a conversation I am in changed; with counts when my own read marker moved); `{ event: 'chat.channels', channelId, change: 'added' \| 'removed' \| 'updated' }` | the person |

- **`subscribed`** for a chat topic carries `seq` = the conversation's `LastSeq`. A conversation the person may not read
  answers `error` `not-found` (as for one that does not exist).
- **Ordering and gaps.** Every change of a conversation takes the next value of `LastSeq` in its transaction, under the
  channel's row lock; pushes go out after the commit, in seq order per channel (a push that overtakes its predecessor
  waits up to 300 ms), with `prev = seq - 1`. The client keeps the last seq it applied per conversation: `prev` above it
  is a gap; then, and after a reconnect (compare `subscribed.seq`) or a new `epoch` in `hello`, it calls
  `GET /chat/conversations/:id/changes?after=<last applied>`; `reset: true` means reload the latest page. A push whose
  seq is not above the last applied is old: ignore it.
- **What a push carries**: the message as readers see it (body, text, sender, files' names, card references, reactions),
  never resolved card contents. For `members` and `channel` the message is the system message; a retention purge is a
  `channel` push without a message (its seq is the new `purgedSeq`).
- **Access changes**: removing a member, leaving, archiving an open channel, deleting a conversation, losing access to
  the chat environment: the subscriptions are checked again at once and end with `{ t: 'unsubscribed', topic, reason }`;
  the person also gets `chat.channels` `removed`.
- `X-Appbuilder-Live: <connection id>` on writes marks the push `self` on that socket.
- **One socket per tab** (package E): the chat store subscribes its topics on the page's live connection
  (`src/platform/live.ts`, obtained with `pageLiveClient()` from `remote-live.ts`); there is no second socket. The
  client routes `chat` and `typing` pushes by topic, gives chat topics their `subscribed` answer (with the seq),
  `unsubscribed` and a refused subscription (`error` answering the `sub` id) reach the topic's handlers, and an
  environment switch keeps install-wide topics (`user:`, `chat:`) and kept ones (a chat card's table topic in another
  environment, `subscribe(..., { keep: true })`). The browser going offline closes the socket at once.

## Presence

Package E decided **not** to build online dots in direct conversations. The hub's presence (`presence:online`) is for
administrators; a dot per direct conversation needs a new hub topic whose answer is computed per pair of people (only
people who share a conversation may learn that the other is online, honouring "Hide my presence"), in
`server/core/live/**`, for a small gain. Default 10 of the spec stays open for a later package.

## Notifications

`services.notifications.notify()` with kind `chat`, idempotency key `chat:<messageId>:<userId>`, link
`#chat?c=<channelId>&m=<seq>`, environment = the chat environment. Who: people mentioned (and everyone on @channel),
members of direct and group conversations (notify level all by default), members of channels whose level is `all`
(channels default to `mentions`). Never: the sender, muted members, level `none`. An edit notifies only people newly
mentioned. Title: "Asha mentioned you in #Quality", "Asha sent you a message", "Asha in #Quality"; body: up to 140
characters of the text (never card values). Email: the person's choice, default digest (`effectiveChannels`); the digest
drops a chat item that was read, deleted or can no longer be read when it is composed (`setDigestRelevance`, delivery
log status `dropped` with the reason). WhatsApp: only through an administrator-mapped template, as for every kind.

## Search

`GET /chat/search` computes the reader's readable conversations first (member, or open channel), then searches only
their messages: `to_tsvector('simple', BodyText) @@ to_tsquery('simple', <words>:* & ...)` or a file name match, not
deleted, not system; ranked by `ts_rank` then recency, 20 per page. The words are letters (with combining marks) and
digits only. No other rows are ranked or counted. Card contents are not searched. Record discussions: Query v2 search on
Comments.

## Retention

Job `chat.retention` (install schedule `sched_chat_retention`, 02:17 every night; install administrators may change it):
for each kind with a period, removes messages older than it (a thread with its first message), with their reactions,
mentions, reports and files; raises `PurgedSeq` and pushes a `channel` change. No message is removed while no period is set (draft files older than a day are).
Paused while the install is read-only (`APPBUILDER_READ_ONLY=1`: sends, edits and new conversations are refused with the
read-only message; reading, search and administrator export work).

## Tests

- `server/core/chat/chat-policy.test.ts`: the policy evaluated against rows in memory (every table and operation; member,
  non-member, owner, administrators; open, private, archived, direct, group), format and settings helpers.
- `server/core/chat/chat-security.integration.test.ts`: the leak suite (see the file header for the list).
- `server/core/chat/chat.integration.test.ts`: contiguity under 50 parallel senders, gap recovery, idempotent sends,
  paging, threads, edits, deletes, notifications and the digest check, files, typing, moderation and audit, retention
  with a moved clock, environment copy and delete, the 13 -> 14 upgrade; `APPBUILDER_BENCH=1` adds the 100,000-message
  search run.
- `scripts/exit-check/p3-chat.mjs`: exit checks 1 to 8, API level, and the browser part (packages B and E: 4E share to
  chat per reader, 6E discussions, 15E approval cards and the timeline, 1E one socket per tab across an environment
  switch, the Mentions page, a deep link to an old message).
- `src/chat/socket.test.ts` (chat on the page's live connection), `src/chat/share.test.ts`, `src/chat/timeline.test.ts`
  ("a deep link to an old message").
