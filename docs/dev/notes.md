# Notes (P3 package N)

A note is an Activity of Type `Note` (core data model, [core-data-model.md](core-data-model.md)) with a rich-text `Body`
and its own `Files`; it is shared through `ActivityShares` ([tasks.md](tasks.md#shares)). User help:
[Notes](../help/notes.md); teams and makers: [guide](../guide/notes.md). Exit check: `scripts/exit-check/p3-notes.mjs`.

| File | What |
| --- | --- |
| `src/notes/sanitize.ts` | The body format: `NOTE_TAGS`, `parseNoteHtml` (untrusted HTML to an allow-listed tree), `serializeNote`, `sanitizeNoteHtml`, `noteToPlain`, mention / record / image extraction. Pure, shared by server and client. |
| `src/notes/merge.ts` | Three-way merge of the top-level blocks of two edits of a note (the "Merge both" choice). |
| `src/notes/autosave.ts` | Autosave state machine (debounce, max wait, one save at a time, version per save, conflict, retry, adopt, rebase). |
| `src/notes/logic.ts` | Mention query at the caret, added mentions, share diffing, search highlighting and snippets. |
| `src/notes/dom.ts` | Tree to elements (createElement, never innerHTML) and the editor's DOM back to a sanitised body. |
| `src/notes/NoteEditor.tsx`, `NotesPage.tsx`, `QuickNote.tsx`, `api.ts`, `notes.css` | The editor, the page `#u-notes`, the shell's quick note and the timeline's "New note" button, the HTTP calls, the styles. |
| `server/core/notes/service.ts` | Installs the sanitiser (`tasks.setNoteSanitizer`) and the mention hook (`tasks.setNoteHooks`), the `notes.notify` job, pins. |
| `server/core/notes/routes.ts` | `/api/v1/notes` routes (below). Registered in `server/core/app.ts`. |

## The editor decision

The spec's default was TipTap (MIT parts) under a 300 kB budget (minified, added to the single-file build). Measured on
2026-11-21 with TipTap 3.35.0 (every package and every transitive dependency MIT: `@tiptap/*`, `prosemirror-*`,
`orderedmap`, `rope-sequence`, `w3c-keyname`, `linkifyjs`, `fast-equals`, `use-sync-external-store`, `@floating-ui/*`;
`license` fields and LICENSE files read) in an isolated bundle with React external, minified by the build's own bundler
(rolldown):

| Set-up | Minified | Gzip |
| --- | --- | --- |
| StarterKit + Table + Image + TaskList + Mention + `@tiptap/react` | 479.6 kB | 151.0 kB |
| StarterKit + `@tiptap/react` | 394.2 kB | 123.9 kB |
| StarterKit, `@tiptap/core` only | 375.4 kB | 117.8 kB |

Every set-up is over budget, so the fallback was built: an own editor over `contenteditable` (about 55 kB minified for
all of `src/notes`, 19 kB gzip, plus 4 kB of CSS). No dependency was added. The browser does the typing (input methods,
the on-screen keyboard, touch selection, native undo); `document.execCommand` does bold, italic, underline, headings,
quotes and lists; the editor builds checklists, tables (add row / column), mentions, record cards and images itself.

## The body format and the sanitiser (the security boundary)

Every write of `Body` (data API, flows, imports: whatever writes Activities) goes through `sanitizeNoteHtml` in
`tasks.beforeActivityWrite` (also the default there, so every services instance is safe); the editor's own cleaning is
convenience only. Allow-list:

- tags: `p br b i u s ul ol li a code pre blockquote span h1 h2 h3 table thead tbody tr th td img` (aliases mapped:
  strong, em, del, strike, div, h4-h6 ...);
- attributes: `a href` only `https://`, `http://`, `mailto:` or in-app `#...` (output with `rel="noopener noreferrer"
  target="_blank"` for external ones); `span data-mention` (a user id; text only inside); `span data-record="table:row"`
  (stored EMPTY: the label is resolved per reader, so no record value is ever stored in a note); `ul data-type="checklist"`;
  `li data-checked="true|false"`; `img data-att="att_..."` only (an image without it is dropped; the client shows only
  images that are in the note's own `Files`). Nothing else: no style, class, id, event handler, src;
- dropped with their content: script, style, iframe, frame(set), object, embed, applet, svg, math, template, noscript,
  noembed, noframes, textarea, title, xmp, plaintext, select, option, head, video, audio, canvas, map, datalist, button;
  comments, doctype, CDATA and processing instructions dropped; unknown tags unwrapped (text kept, escaped);
- repaired: tags balanced, list items only in lists (else a paragraph), rows and cells only in tables (an implied row
  is added), no table in a table (the inner one is unwrapped into the cell), no block inside an inline element, no link
  in a link, nesting depth at most 24; entities decoded once and every text and attribute written back escaped;
  control characters and invalid code points removed; the output is idempotent;
- size: the server refuses a raw body over 400,000 characters and a cleaned one over 200,000 (`NOTE_BODY_MAX`).

The hostile corpus (`src/notes/sanitize.test.ts`, 70+ cases) covers script in every form (case, split tags, inside SVG,
template, noscript), event handlers (quoted, unquoted, encoded quotes in attributes), `javascript:` / `vbscript:` /
`data:` URLs (encoded, with tabs and spaces), style attributes and elements, SVG and MathML, iframes (src and srcdoc),
object / embed / link / meta / base / form, comments and CDATA hiding markup, malformed nesting (unclosed, stray closers,
blocks in inline elements, lists and table parts out of place, nested tables), entities (NUL, surrogates, out of range),
control characters, a 5,000-deep nesting, a 400,000-character body with 10,000 script tags (linear time), and 20,000
repeated handlers. Every output is checked for allowed tags and attributes only, balanced tags, no markup outside them
and idempotence. Rendering never uses innerHTML or `dangerouslySetInnerHTML`: `dom.ts` creates each element.

## Sharing and reading

No new rule: the Activities read predicate already is "about a record I can read, assigned to me or my teams, my own
unregarded, or shared with me or one of my teams" and update adds "an edit share"; only the owner (and administrators)
write `ActivityShares`. Pinned per person: `ab_counters` keys `notes.pin:<user>:<note>` in the environment schema (no
schema change). Pins of notes the person can no longer read are ignored (every list reads through the DataService).

## Mentions

`tasks.afterActivityWrite` calls the Notes hook inside the write's unit of work: the people newly mentioned in the body
(compared with the previous body; at most 50 per save) must be able to read the note (`collab.readersOf`, which sees the
row being written), else the whole save is refused with 422 ("... cannot open this note, so they cannot be mentioned.
Share the note with them first."). Each mentioned reader gets a Mentions row about the note (`regardingTable` =
`sys_activities`, `Comment` empty) and, after commit, job `notes.notify` checks access again and sends a notification
(kind `mention`, link `#u-notes?n=<id>`, idempotency key per note, person and version). The page asks
`POST /notes/:id/readers` and, for the owner, offers to share (read) before inserting the mention.

## Conflicts

Saves are `PATCH /data/sys_activities/rows/:id` with `ifModifiedOn` (the version the edit started from): the data API's
existing version check answers 409 with the saved row. Autosave then stops and the page shows the choice (keep mine,
take the saved text, merge both when `mergeNotes` finds no overlapping change). A tab with no unsaved edit takes a
newer version silently (`adopt`, on the live `table:sys_activities` tick). Adding an image or file changes the row's
version: when the saved text is unchanged the next save moves to the new version without asking.

## Routes

| Route | Answer |
| --- | --- |
| `GET /notes?view=all\|mine\|shared\|records\|pinned&q=&limit=` | `{ items }`: id, title, snippet (plain text around the first match), times, owner, pinned, `sharedWithMe` (read / edit), file count, regarding label (blank when the reader cannot read the record). Never the body. Search: each word must be in the title or the text (Query v2 `contains` on Subject and Body, then checked on the plain text). |
| `GET /notes/:id` | the note, `version`, `canEdit`, `isOwner`, `pinned`, regarding, shares with names |
| `POST /notes/:id/cards` | record cards of the body resolved for the caller with chat's `resolveCardRef` (same rule: the reader's own access) |
| `PUT /notes/:id/pin { on }` | pin / unpin |
| `POST /notes/:id/readers { userIds }` | `{ readers, notReaders }` |

A note the caller cannot read answers 404 "Note not found." on every route.

## Offline, read-only install, phone

Online only: notes are not in the offline store; offline the page says so and the editor is read-only (edits already
typed stay in the open tab and are saved when the connection is back). Notes add no rule of their own for a read-only
install ([hosting-spec.md](../plan/hosting-spec.md)): they follow what the data API enforces for every table. Phone: list and note each full screen under 768 px, 44 px targets, the editor keeps
`var(--kb)` (the on-screen keyboard, [phone.md](phone.md)) free below the text.

## Not done

- Server-side PDF of a note through the print engine: the print templates engine renders its own document model, not
  note HTML; "Print" uses the browser's print (and its Save as PDF) with a print style that shows only the note.
- Record cards show the record's name only (no fields) and do not open the record (there is no generic record page).
- No real phone was used: phone width, touch and the keyboard inset were checked in headless Chrome only; Devanagari
  input was checked with typed text and a Chrome input-method composition, not a physical keyboard or a phone IME.
- The record timeline does not have the "Note" button yet: `NewNoteButton` (`src/notes/QuickNote.tsx`) is ready for it.
