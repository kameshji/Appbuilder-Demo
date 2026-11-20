# Notes for teams and makers

Notes are rich-text notes kept per environment: private by default, shared with people or teams to read or edit, and
optionally about a record. This page is for whoever sets up how a team works with notes. Day-to-day use is in the help:
[Notes](../help/notes.md). Developers: [notes (server, sanitiser, editor)](../dev/notes.md).

## Who sees a note

| Who | Sees the note | Changes it | Shares or deletes it |
| --- | --- | --- | --- |
| Its owner (who wrote it) | yes | yes | yes |
| A person or team it is shared with "Can read" | yes | no | no |
| A person or team it is shared with "Can edit" | yes | yes | no |
| Someone who can read the record the note is about | yes (also on the record's timeline) | no | no |
| An environment administrator | yes, as for every collaboration table | yes | yes |
| Everyone else | no: the note does not appear in lists or search, and its address answers "Note not found" | no | no |

- A share with a team follows the team's members at the time: someone who leaves the team stops seeing the note at once.
- Sharing a note never shares the record it is about; a record card in a note shows each reader only what they may see.
- Mentions only reach people who can open the note; the page offers to share it first.

## Suggested use

- Visit reports and shift notes **about a record** (a customer, a machine, an order): everyone working on that record
  finds them on its timeline, and nothing needs sharing.
- Team notes (procedures, meeting notes) shared with a **team** with "Can edit".
- Checklists for a person, private, pinned.

## What notes are in the data

A note is a row of the system table Activities with Type `Note`: apps and flows that read Activities see the notes the
person may see, under the same rules as above. The text is stored as a limited set of HTML (headings, lists, checklists, tables, links, mentions,
record cards, images of the note's own files); anything else is removed when the note is saved, whatever wrote it.
