# Chat for teams and makers

Chat is the one conversation space of your Appbuilder install: channels, direct conversations and small groups, next to
the apps people work in. This page is for whoever sets chat up for a team: how it is organised, what people can and
cannot see, and how it fits with apps. How to use it day to day is in the help: [Chat](../help/chat.md). Administrators:
[chat for administrators](../admin/chat.md). Developers: [chat (server and protocol)](../dev/chat.md).

## How it is organised

| Kind | Who reads it | Who joins or adds people | Notes |
| --- | --- | --- | --- |
| Open channel | everyone who uses chat | anyone joins (Browse open channels) | good for a plant, a shift, a topic |
| Private channel | its members only | its owners add people | its name is invisible to everyone else, administrators' chat screens included |
| Direct conversation | the two people | nobody (one per pair) | cannot be left |
| Group conversation | its members (3 to 8 people) | any member | for a small ad-hoc group |

- One chat per install: the same channels from every environment, the Studio and phones. Chat's messages and files are
  stored in one environment (the chat environment) and its backups.
- Channels can be created by everyone who uses chat, or by makers and administrators only (Admin console > Chat).
- A channel can be an **announcement channel** ("Only owners post"): everyone reads, owners write.
- People choose per conversation: every message, mentions only, or nothing; and mute. Channels default to mentions only.

Suggested set-up for a small plant: an open channel per line or area (`#Line 1`, `#Stores`), a private channel per team
that handles sensitive matters (`#Quality`, `#Maintenance`), an announcement channel for the plant manager.

## What people see

Chat applies the same rule everywhere: a person reads a conversation only if they are in it (or it is an open channel).
That holds for the list, search, notifications, the Mentions page, files and the data API. A mention of someone who
cannot read the conversation is refused with the reason, and the mention list only offers people who can read it.

**Cards.** A record, an app or a dashboard shared in a conversation is a reference, never a copy: each reader sees on
the card what their own roles allow (a hidden column is left out, a hidden record shows "Not available"), and the card
follows changes to the record. Buttons to share from apps and dashboards come in a later update; until then cards come
from the API (`cards` of a message, [chat API](../dev/chat.md#http-api)).

## Chat and your apps

- Chat opens in the panel at the side of every screen and of the Studio (left or right: Settings > Chat), in a window of
  its own (Pop out), or full screen on a phone (menu > Chat).
- Apps and flows can read chat tables (Channels, Channel members, Messages, Message reactions) through formulas and
  queries only as far as the signed-in person may; nobody writes them except chat itself. Prefer sending people
  notifications (`SendNotification`) over building chat into apps.
- Discussions about a single record stay in the record's comments (its timeline), not in chat.

## Limits

4,000 characters per message, 10 files of up to 25 MB each, 30 messages a minute per person, 1,000 members per channel,
8 people per group, 12 reaction emoji. Chat needs a connection to the server: nothing is sent while offline.

## Not supported

Calls, screen sharing, people outside your organisation, bots, read receipts per person, presence dots, members
exporting a conversation, moving chat to another environment once it holds messages.
