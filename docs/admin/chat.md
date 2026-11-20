# Chat for administrators

Chat lets the people of your organisation talk in channels, direct conversations and small group conversations, next to
their apps. This page says where chat lives, what administrators can and cannot see, and how retention, moderation and
export work. Developers: [chat (server and protocol)](../dev/chat.md). Security in short: [security model](security-model.md#chat-phase-3).

The chat screens (the dock, the conversation list, Admin console > Chat) come with the chat UI; until then the server
part described here is reached through the API.

## Where chat lives

- **One chat per install.** Chat is stored in one environment, the **chat environment** (Default unless an install
  administrator chose another). Its messages and files are in that environment's tables and attachment folder, and in its
  backups: restoring the chat environment from a backup restores chat to that point too.
- People reach the same chat from every environment and from the Studio.
- **Who can use chat:** every active person with access to the chat environment, and install administrators. API keys and
  service accounts cannot.
- The chat environment can be changed (`environmentId` in the settings, install administrators) **only while chat holds
  no messages**. Moving existing history to another environment is not built.
- The chat environment **cannot be deleted while it holds messages**.
- **Environment copies never take chat along**, with or without data. Solutions never contain chat.

## Settings

| Setting | Default | Who |
| --- | --- | --- |
| Who may create channels | everyone who uses chat (or: makers and administrators only) | administrators of the chat environment |
| Retention per kind (channels, direct, group) | keep everything | administrators of the chat environment; at least 30 days |
| Read-only people | none | administrators of the chat environment |
| The chat environment | Default | install administrators, only while chat is empty |

Every change is in the audit log of the chat environment (`chat.settings`, `chat.readonly`).

## What administrators can and cannot see

Administrators of the chat environment (and install administrators) **can**:

- see every conversation's name, kind (channel, direct, group), members, number of messages, open reports and dates;
- read the text of a message **a member reported** to them (the reporter chose to show it);
- **export one conversation** with a typed reason (see below): this is the only way an administrator reads a conversation
  they are not in, and its members are told.

They **cannot**, through the product:

- read the messages of a private channel, a direct or a group conversation they are not in: not in the chat screens, not
  through Query v2 or the data API, not in CSV exports, the environment data export, dashboards, print templates, flows or
  a backup's table browser. Administrators read chat exactly like everyone else: their own conversations and open channels;
- add themselves or anyone to a private conversation through the data API (nobody writes chat tables that way).

What the software does not prevent: install administrators can download a backup archive, which contains the chat
environment's database, chat included; anyone with direct access to the database server reads everything. Restrict who
holds install administrator rights and database access accordingly.

**Legal note.** Whether reading, keeping, exporting or deleting employees' conversations is allowed, required or must be
announced in your organisation (employment law, data protection, retention duties) is a question for your lawyer. This
page only says what the software does; the wording of the export notice and the retention defaults are product defaults,
not legal advice.

## Moderation

| Action | What happens | Audit action |
| --- | --- | --- |
| Delete a message | Its text, files and reactions are removed; a "message deleted by an administrator" line stays in the conversation | `chat.message.moderate` |
| Handle a report | Delete the reported message, or dismiss the report | `chat.report.handle` |
| Archive a conversation | Read-only for its members; an archived open channel can no longer be read or joined by non-members | `chat.channel.archive` |
| Delete a conversation | Gone for good with its messages and files (type its name to confirm) | `chat.channel.delete` |
| Remove a member | They stop receiving the conversation at once (also on open screens) | `chat.member.remove` |
| Make someone read-only | They read, they cannot post, react or start conversations | `chat.readonly` |

Audit entries keep who, when, which conversation and which message id. **They never keep message text.** Ordinary sends
are not audited.

Members report a message with a reason; administrators of the chat environment get an in-app notification that a report
waits (without the message's text).

## Export of one conversation

An administrator of the chat environment exports one conversation:

1. types the reason (at least 10 characters); a recent sign-in is required;
2. the export is recorded in the audit log (`chat.export`, with the reason, the conversation and the number of messages
   and files), and **a system message in the conversation tells its members**: "An administrator exported this
   conversation on <date>." The message cannot be removed by members;
3. the administrator downloads a ZIP within an hour: `transcript.html` (every message with sender and time, edits marked,
   deleted messages as such, system lines) and the files. Only the administrator who created it can download it;
   downloads are audited (`chat.export.download`).

Cards in messages (shared records, apps, dashboards) are not in the export: each reader sees them with their own access.
Members cannot export in this version.

## Retention

By default chat keeps everything. An administrator may set a period (at least 30 days) per kind of conversation. Every
night (job `chat.retention`, schedule "Chat retention" at 02:17, install administrators may change the time) messages
older than the period are removed for good, with their reactions, mentions and files; a thread goes with its first
message. People with the conversation open see it reload. The job's run log says how many messages and files it removed.
An administrator can also run it now (`POST /api/v1/chat/admin/retention/run`; `chat.retention.run` in the audit log). Drafts of files that were uploaded but never sent are removed after a day. Retention waits while the install is read-only.
Removed messages remain in backups taken before.

## Limits

4,000 characters per message, 10 files of at most 25 MB each, 30 messages a minute per person, 1,000 members per channel,
8 people per group conversation, 12 reaction emoji. An `@channel` mention notifies everyone; in channels above 50 members
only owners and administrators may use it.

## Notifications

Direct messages and mentions notify in the app; email follows each person's choice in Settings > Notifications ("Chat"),
by default in their digest, and an item read before the digest is composed is left out. Ordinary channel messages only
raise the unread count unless a person sets the channel to "all". WhatsApp only when an administrator mapped an approved
template for chat and the person opted in. Notifications and emails never carry the values of shared records.

## What is not supported

Calls, screen sharing, people outside the organisation, bots (other than system messages), read receipts per person,
moving chat history to another environment, member exports, editing a message's files after sending.
