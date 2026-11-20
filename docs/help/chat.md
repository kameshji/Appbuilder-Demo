# Chat

Chat lets you talk to the people you work with, next to your apps: in channels for a team or a topic, in direct
conversations with one person, and in small groups. Your company has one chat for everyone; you reach the same chat from
every app, from the Studio and from your phone.

## Open chat

- **On a computer:** click the chat button in the top bar (the speech bubbles, next to the bell). Chat opens as a panel on
  the right of the screen (or on the left: Settings > Chat). A red number on the button counts your unread direct messages
  and the times someone mentioned you. Drag the panel's edge to make it wider.
- **In its own window:** in the chat panel, click **Pop out**. The window shows the list and the conversation side by side.
  **Back to the main window** (or **Bring back** in the panel) returns it.
- **On a phone:** open the menu and tap **Chat**. Chat fills the screen: first the list of conversations, then the
  conversation you tap. The phone's Back button returns to the list; the arrow at the top returns to your app.

Chat needs a connection to the Appbuilder server. When the connection drops, a line at the top says so; messages that
arrived meanwhile appear when it is back, in the right order. You cannot send while you are offline.

## The list of conversations

Your conversations are listed with the latest activity first. A number shows unread messages; **@** shows that someone
mentioned you. A crossed-out bell means you muted the conversation.

- **Search** (the box at the top) finds conversations by name and, from two letters on, messages and file names in the
  conversations you can read. Click a message to jump to it.
- **New conversation** (the speech bubble with a plus): **Direct** (one person), **Group** (two to seven others) or
  **Channel** (a name, private or open, and the first members). Your administrator may allow only makers and
  administrators to create channels.
- **Browse open channels** (the compass): open channels anyone may read and join.

A **private channel** is visible only to its members: other people do not see its name, its messages or its files, and
cannot find it by search. An **open channel** can be read and joined by everyone who uses chat.

## Writing

Type in the box at the bottom and press **Enter** to send. **Shift+Enter** starts a new line (on a phone, Enter is a new
line and the arrow button sends).

| Type | You get |
| --- | --- |
| `*bold*` | **bold** |
| `_italic_` | *italic* |
| `~struck~` | struck out |
| `` `code` `` | `code` |
| a line starting with `- ` | a bulleted list |
| a line starting with `1. ` | a numbered list |
| a line starting with `> ` | a quote |
| a web address, or `[text](https://...)` | a link |

**Ctrl+B**, **Ctrl+I** and **Ctrl+E** make the selected text bold, italic or code. A message can be up to 4,000
characters.

**Mentions:** type **@** and the first letters of a name, then pick the person (arrow keys and Enter, or click). The list
only offers people who can read the conversation; in a private channel you cannot mention someone who is not in it.
**@channel** tells everyone in the channel (in channels of more than 50 people only their owners can use it). The person
you mention gets a notification under the bell; clicking it opens chat at that message.

**Files and photos:** click the paper clip, drop files on the conversation, or paste a picture. Up to 10 files of at most
25 MB each per message; a larger file is refused before it is sent. Photos show in the conversation; members open the
files, nobody else can.

If a message cannot be sent, it stays in the conversation marked **Not sent** with the reason: **Retry** sends it again
(it is never sent twice), **Delete** drops it. A message the server refused (for example a mention of someone outside a
private channel) offers **Edit and send again**.

## Reading, threads and reactions

Point at a message (or move to it with Tab) to see its buttons:

- **Add a reaction**: one of 12 emoji. Click a reaction under a message to add or take back yours.
- **Reply in a thread**: replies stay together under the message ("3 replies"); click that line to open the thread.
- **More**: **Edit** and **Delete** your own messages (an edited message says "edited"; a deleted one leaves "Message
  deleted"), **Report to the administrators** for someone else's message, **Copy text**.

A red **New** line shows where your unread messages start. Older messages load as you scroll up. Messages you read on one
device or tab count as read everywhere.

Someone typing shows under the conversation ("Asha is typing...").

## Cards and Share to chat

When a record, an app or a dashboard is shared in a conversation, it shows as a card. Each person sees on the card only
what they may see in Appbuilder themselves: a field you may not read is left out, and a record, app or dashboard you may
not open shows "Not available". Cards never appear in emails. A record card follows changes to the record.

To share one yourself, use **Share to chat** (the share button):

- on a **record**: at the top of its timeline (the Record timeline UI component in an app);
- on an **app**: on its tile in the app launcher;
- on a **dashboard**: in the dashboard's toolbar.

Pick one of the conversations you may write in, and for a record the fields to show (up to six; the record's name is
always the card's title). You can add a message. The card holds a reference only: people who may not see a field, the
record, the app or the dashboard do not get it from the card either.

## Discussions

A record's discussion is its comments, on the record's timeline. In the chat panel, **Discussions** (next to
**Conversations**) lists the records you follow and the records where someone mentioned you in a comment, newest comment
first, with the number of comments you have not read yet. Click one to open the record in the app it was discussed in.
Opening a record's timeline counts its discussion as read. If you lose access to a record, its discussion disappears from
the list as it does from the timeline.

On the timeline you can **Edit** and **Delete** your own comments. An edited comment says "(edited)"; the earlier text is
not kept. When you type @ in a comment, the list offers only people who can see the record.

## Approvals in chat

Approval requests waiting for you also arrive as cards in your conversation with **Approvals** (it appears in your list
the first time). Each card shows the request (its title, who asked, the due date, the fields the request declared) and
the answer buttons: pick one, add a comment (some answers need one: the card says so, and refuses the answer without
it), then **Send**. This is the same answer as in **Approvals** (the inbox): delegation, reassignment and every rule of
the request apply, and an answer cannot be changed afterwards. When the request is decided somewhere else (in the inbox,
by an email button, or by another approver), the card shows the decision by itself. Nobody can write in the Approvals
conversation; you cannot answer by typing.

If you switch off approval notifications in the app (**Settings > Notifications**, Approvals), no cards arrive either.
Each answer also shows on the timeline of the record the request is about, for the people who may see the request.

## Mentions page and old messages

The **Mentions** page lists where you were mentioned in comments and in chat; a chat mention opens the message in chat.
A link to an old message opens the conversation at that message (with the messages around it); **Jump to the latest**
brings you back to the newest messages.

## Notifications and settings of a conversation

Click **Details** (the i at the top of a conversation) for its members and your own settings:

- **Notify me about**: every message, mentions only (the default for channels), or nothing. Direct and group
  conversations notify you of every message by default. Ordinary channel messages only raise the unread number.
- **Mute**: no notifications at all and no number on the chat button.
- **Members**: who is in it. Owners of a private channel add and remove people; anyone may add people to an open
  channel or a group.
- **Leave** (not direct conversations), **Archive** (owners; an archived conversation can be read, not written).

Email for chat follows your choice in **Settings > Notifications** ("Chat"); by default chat items come in your digest,
and only if you have not read them by then.

## Keyboard

| Keys | What they do |
| --- | --- |
| Up / Down in the list | move between conversations; Enter opens one |
| Alt+Up / Alt+Down | the previous / next conversation |
| Escape | close the mention list, cancel an edit, back to the list |
| Up in an empty message box | edit your last message |

## What administrators can see

Administrators see the names, kinds and members of conversations, not the messages of conversations they are not in.
When you report a message, they see that message and your reason. An administrator can export a conversation for a reason
they must type; the conversation then shows "An administrator exported this conversation on <date>". Your company may
remove old messages after a period it chose.

## What chat does not do

Calls and screen sharing, people outside your company, read receipts per person, presence dots (who is online),
changing the files of a message after sending, sending while offline, exporting a conversation yourself, answering an
approval by replying to its email.

Administrators: [chat for administrators](../admin/chat.md).
