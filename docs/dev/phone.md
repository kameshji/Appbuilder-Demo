# Phone experience (P2 package A)

How Appbuilder apps run on phones: the layout rule, touch handling, the installable web app (PWA), the scanner and
camera, the signature pad, the offline entry outbox, tables kept on the device, form drafts, connectivity, and what is
and is not tested. The code is in `src/phone/` (client),
`server/core/pwa.ts` and `server/core/offline.ts` (server), with small hooks in `src/platform/remote.ts`,
`src/platform/offline-hook.ts`, `src/runtime/RunSurface.tsx`, `src/runtime/RenderNode.tsx`, `src/runtime/evaluator.ts`,
`src/runtime/RunApp.tsx` (offline tables, draft scope) and `src/runtime/host.ts` (Patch with file tokens).

Fixed decisions (`docs/plan/p2-spec.md`): the phone is the same web app in the phone browser, installable as a PWA; no
native app. Offline scope is an outbox of creates/updates (and photo uploads) per device for apps marked "Works offline
(entry)"; reads use the last loaded data; conflicts use the row version.

## Start-up

`src/main.tsx` imports `src/phone/phone.css` and calls `startPhone()` (`src/phone/start.ts`):

| Part | File | What it does |
| --- | --- | --- |
| Environment | `env.ts` | `<html>` classes `touch` (coarse pointer), `ios`, `android`, `standalone`; CSS variables `--vvh` and `--kb` (keyboard inset from `visualViewport`); a focused text field in a running app is scrolled into view above the keyboard 300 ms after focus and on every viewport resize. `useDevice()` is the reactive snapshot. |
| Touch areas | `hit.ts` | forwards a tap on a UI component's extended touch area to its nearest inner control |
| Connectivity | `connectivity.ts` | online/offline state from every request (`noteNetwork`) and the browser events; while offline, probes `/api/v1/status` with backoff 2 s ... 30 s |
| Offline | `offline/index.ts` | registers the offline hook in the platform (`src/platform/offline-hook.ts`) |
| PWA | `pwa.ts` | registers the service worker; `?app=<id>` start address -> `#u-<id>` |

`index.html` has `viewport-fit=cover, interactive-widget=resizes-content` (Chrome on Android shrinks the layout for the
keyboard; iOS does not, hence `env.ts`), `theme-color`, the Apple web-app tags and the manifest link.

## Layout rule for phone and tablet designs

`fluidSurface` / `usesFluidLayout` in `src/runtime/layout.ts`, used by `RunSurface`:

- Applies to an app whose design size is a phone or tablet size (`deviceOf` in `sizes.ts` is not Desktop) and
  `scaleMode` is responsive, when it runs on a touch device or in an area narrower than 600 px.
- **Width: 1:1 and fluid.** The screen is as wide as the device. The design width is the minimum breakpoint: a device
  narrower than the design scales the screen down (never a sideways scroll); a wider one (a large phone, landscape)
  stretches it, and UI components follow their horizontal anchors (Stretch, End, Center, Scale).
- **Height: at least the design height and the device height.** Taller content scrolls vertically (the area is
  `overflow-y: auto`); a device taller than the design grows the screen so bottom-anchored UI components stay at the
  bottom. The keyboard does not shrink the screen (it scrolls instead).
- Otherwise (desktop windows, desktop designs, `fit`) nothing changed: `surfaceSize`.
- `data-run-surface="fluid" | "fixed"` marks the area for CSS and tests; App.Width/App.Height are the screen size.

Makers: anchor fields and buttons left+right (Stretch) so they use the width of large phones; keep the design at 360
wide (the narrowest common phone) or 390/412.

## Touch

- `phone.css` (all under `html.touch` / `html.touch-preview`): `touch-action: manipulation` on everything tappable (no
  double-tap zoom or click delay; pinch zoom stays), `overscroll-behavior: none` on the page, 16 px text in fields on iOS
  (Safari zooms into smaller text), 100dvh, safe-area padding of `#root`.
- **44 x 44 px touch areas.** `RenderNode` sets `data-hit` on the wrapper of an interactive UI component (the touch
  matrix's `interactive`) that is smaller than 44 px in run mode. CSS draws an invisible `::after` around it (z-index -1
  inside the wrapper, which is made a stacking context): taps on the component itself reach it as before, taps on the
  extra area land on the wrapper and `hit.ts` forwards them to the inner control nearest to the tap (a rating star, a
  pagination button). Slider thumbs and `[data-touch-target]` elements get their own extended area.
- Tab lists scroll sideways on touch; `[data-hover-reveal]` content is always visible.
- **Pull to refresh** (`PullToRefresh.tsx`) on the fluid surface reloads the app's data sources; the browser's own
  pull-to-refresh is off (it would reload the page and lose typed values).
- **Bottom sheets** (`sheet.tsx`, `sheet-picker.tsx`): on touch devices Dropdown, ComboBox and PersonPicker open a bottom sheet
  (search field, 44 px rows, a Done button for multiple selection; server-backed ComboBoxes load more near the end).
  The sheet is portal'd to `document.body` (the RenderNode screen wrapper has `transform`, which would make `position:
  fixed` relative to the screen), sits at `bottom: var(--kb)` with `max-height` from `--vvh`, and closes by Escape, a tap
  on the backdrop or a drag down on the handle (`dragDismiss`). Portals of open-but-hidden app tabs are not shown
  (`usePaneVisible`). Desktop keeps the Radix popovers.
- **Android Back** (`back.ts`): while a bottom sheet is open (the picker sheets, and a Dialog or Sheet drawn as a bottom
  sheet) one history entry is pushed for it (`history.state.__abLayer` = its depth; the URL does not change, and the
  shell routes on `hashchange` only). The Back gesture pops it and the sheet closes (a Dialog runs its OnClose; if the app
  keeps it open it gets a new entry). Closing a sheet any other way takes its entry back off with `history.back()` (that
  popstate is ignored), so no stray entries are left. Nested sheets close one per Back. Desktop popovers push nothing.
  The rules are the pure `BackStack` class (tested against a fake history); a sheet closed by an in-app navigation while
  it was open leaves its entry alone (one later Back then does nothing visible). The outbox panel (Radix Sheet) is not
  covered.
- **Native pickers** (`controls/inputs/NativeDate.tsx`): DatePicker, DateRangePicker, TimePicker and the Form's date fields
  use `<input type=date|time>` on touch. The value contract is unchanged (SelectedDate at local midnight, Value
  "HH:MM"; `nativeToDate`/`nativeToTime` in `touch-logic.ts`); Min/Max are applied. The field shows the device's format,
  so `Format` and `Use24Hour` are ignored there. A clear button stays (iOS pickers cannot clear).
- **NumberInput**: `inputmode="numeric"` only for a bounded whole-number range with Min >= 0, otherwise `decimal`; a +/-
  button where negatives are allowed (iOS pads have no minus key); a decimal comma is stored as a point. Form number
  fields take the comma too but have no sign button.
- **Dialog and Sheet** are bottom sheets at phone width (< 600 px) on touch devices (`overlayPlacement`): drag handle, 44 px
  close button, `ab-overlay-sheet`. A top Sheet stays a top sheet. The content is the design-width layout, full width.
- **DataTable cards**: on touch below 600 px (run mode) rows are cards: the title is the first text column, up to 5 more
  columns follow as label: value lines; the new additive property `CardColumns` ("Phone card columns", e.g.
  `Name, Status, Amount`) picks and orders the columns (1st title, 2nd subtitle, rest lines). A "Sort by" select replaces
  the headers; cards load in steps of 100 and a server query loads more near the end. Virtualization is off in card mode.
- **Form sticky save bar** (`sheet-bar.tsx`): when the form's own bottom is below the visible viewport (keyboard, or a form
  taller than the screen) but a useful part is visible (`barPinned`), the Save/Cancel bar is pinned at `bottom: var(--kb)`,
  above the shell's connection bar, with a placeholder keeping the layout. Choice and lookup fields of the Form still use
  the Radix select; `revealFocused` (env.ts) does not know about the pinned bar.
- Alert's dismiss button has a 44 px touch area. **Visual**: invisible 44 px hit circles around points, a tap shows the
  tooltip and a tap elsewhere hides it, 44 px legend rows. **Chart** (recharts) already showed its tooltip on a tap: no
  change. **PrintButton** has a busy state so a second tap cannot download the PDF twice; the download on iOS Safari is
  not verified.
- **Touch matrix**: `src/phone/touch.ts`, one entry per UI component (see the summary below). `src/phone/phone.test.ts`
  fails when a UI component of the registry has no entry, and when an interactive one smaller than 44 px neither gets
  the touch area nor is marked as a limitation. The decision rules above are pure functions in `touch-logic.ts`. New UI components must add an entry.

### Touch matrix summary (84 UI components plus the Screen)

| Status | Count | Meaning |
| --- | --- | --- |
| works | 46 | usable by touch as it was (display-only UI components count here; Chart was reviewed and needed no change) |
| fixed | 39 | changed for touch: P2-A (touch areas, nearest-target taps, tabs scroll, photo capture, scan components), the touch-limitation package (bottom-sheet pickers, native date/time, NumberInput, Dialog/Sheet, DataTable cards, Form save bar, Alert, Visual, PrintButton) and the new SignaturePad |
| limitation | 0 | none left as a matrix status; the remaining gaps are inside the notes (native pickers ignore Format/Use24Hour, Form choice/lookup fields use the Radix select, nothing tested on a real phone) |

The exit script measures the real touch areas of 35 interactive UI components at their default size in Chrome's phone
emulation (all pass; 28 of them need the extended area).

## Scanner

- `BarcodeScanner` (a button that opens the camera; `Value`, `Format`, `ScanCount`, `OnScan`; `Continuous` for stock
  counts, the same code again only after 2 s; torch where the camera track supports it) and `ScanInput` (a field that
  recognises keyboard-wedge scanners and has a camera button): `src/controls/inputs/Scan.tsx`.
- Engines (`src/phone/scan/scanner.ts`): the browser's `BarcodeDetector` when it supports the wanted formats (Android
  Chrome: QR, Data Matrix, EAN, Code 128/39, ITF, ...), otherwise **our own 1D decoder** (`decode1d.ts`: EAN-13 (UPC-A),
  EAN-8, Code 128 A/B/C, Code 39, ITF; checksums verified, 5-module quiet zones, two rows must agree; 0 false reads in
  3,000 random bar rows during development). **No QR or Data Matrix fallback**: on iOS Safari and desktop Firefox/Linux
  Chrome QR codes cannot be scanned with the camera (a keyboard-wedge scanner works everywhere). The sheet says so.
- Keyboard wedge (`wedge.ts`): at least 3 characters, each within 45 ms of the previous, ending with Enter or Tab.
- Frames: about 6 per second, scaled to at most 960 px, decoded on the main thread (no worker, no CSP change).

## Camera and photos

- Form image/file columns that accept images (`AttachmentField`): **Take photo** on touch devices (`<input
  accept="image/*" capture="environment">`: the phone's own camera) and **Use camera** on desktops with a camera (the
  in-page `CameraSheet`, `getUserMedia`, back camera preferred). Permission refusals and missing cameras are said in
  words.
- `preparePhoto` (`src/phone/image.ts`): reads the EXIF orientation itself, decodes with `imageOrientation: 'none'`,
  draws upright scaled to a 1600 px longer side, JPEG 0.85. EXIF (including GPS) is dropped by re-encoding. Non-photos and
  undecodable files are kept as they are. Multiple photos follow the column's `multiple`.
- Photos queue in the outbox like any upload (after their row).

## Signature pad

- Pure maths in `src/phone/signature.ts`, the canvas in `src/phone/SignatureCanvas.tsx`, the UI component
  `SignaturePad` (`src/controls/inputs/SignaturePad.tsx`) and the Form's signature fields
  (`src/controls/inputs/SignatureField.tsx`, Form property `SignatureFields`, additive).
- Pointer events (finger, stylus, mouse; one pointer at a time, coalesced events used); the canvas has
  `touch-action: none` and its box `data-no-pull` (pull to refresh ignores it), so the page neither scrolls nor
  refreshes while signing. The backing store is drawn at `devicePixelRatio` (at most 3).
- Points are kept in pad units (0..1), so a resize or rotation redraws the same signature. A finished stroke is
  simplified (Ramer-Douglas-Peucker, 0.6 px) and drawn smoothed (quadratic curves through the midpoints). The pad is a
  fixed 3:1 area letterboxed into the UI component, with a dashed signature line.
- "Signed" needs at least 12 px of ink (a stray tap is not a signature): `HasSignature` / `IsEmpty`. `OnSign` runs after
  each stroke that leaves the pad signed. `Reset()` clears it (the outputs go back to blank, the drawing follows).
- Export: PNG on white (opaque, so it prints and shows the same everywhere), scaled to fit 1200 x 400 px, at most 3x the
  pad and at least 300 px wide (`exportSize`). Outputs `Image` (a data URL, for an Image UI component) and `FileToken`
  (the same PNG as a file in the attachments registry).
- Saving: in a Form, list the image column in `SignatureFields`: the field is a pad, the PNG becomes the field's pending
  file and is uploaded after the row is saved, exactly like a photo (offline: an upload item after its row). Stand-alone:
  `Patch(Visits, ThisItem, {Signature: SignaturePad1.FileToken})`. The runtime (`splitFileTokens` in
  `src/runtime/attachments.ts`, used by `patch` in `src/runtime/host.ts`) takes token values of image / file columns out
  of the row write, writes the row, then uploads the files (`finishSubmit`); a single-file column is cleared in the write so
  the upload replaces it. A token whose files are gone (an old token after a reload) fails the Patch with a message. This
  also makes `FileUpload1.FileToken` work in Patch.
- Printing: the attachment is a PNG in an image column, so a print template's image block with source `attachment` on
  that column prints it (no print code changed; PNG support is the print engine's existing one).

## Device() and Location()

Formula functions in `src/fx/functions/device.ts`; values from `src/phone/device-fx.ts` through the evaluator's
`resolveName('Device()' | 'Location()' | 'Location():update')`, with dependencies `q:device` / `q:location` bumped
through `runtime/data.ts` (only formulas that read them re-run). `Location()` asks once (one-shot, high accuracy, 20 s
timeout, positions up to 30 s old accepted); `UpdateLocation()` asks again. Statuses: Pending, Ready, Denied,
Unavailable, NeedsHttps. Blank-filled records on the server.

## PWA

- Server (`server/core/pwa.ts`): `GET /api/v1/pwa/manifest.webmanifest` (install manifest, no session),
  `GET /api/v1/pwa/apps/:id/manifest.webmanifest` (an app's manifest: its name, an icon in its theme colour with its
  initials, `start_url` and `id` `/?app=<id>`; users who may run the app), `GET /api/v1/pwa/icon.png?s=&c=&t=&m=` (PNG
  icons drawn by the server: rounded square or maskable full bleed, 5x7 bitmap letters, 4x supersampling; deterministic
  from the parameters, cached a day), `GET /api/v1/pwa/sw.js` (`Service-Worker-Allowed: /`).
- The page links the app's manifest while an app is shown (`setAppManifest`), so "Add to Home screen" adds that app.
  The My apps page shows `AddToHome` on phones (Android Chrome install prompt or menu steps, iOS Safari Share steps).
  App cards have **Open on a phone** (a QR code of `/?app=<id>`).
- **Service worker** (generated source, version = hash of the server version and `dist/index.html` size/mtime): caches
  `/` (the single-file build) and the PWA files; every navigation gets the cached shell of its build (works offline);
  `/api/` is never answered from a cache except the PWA paths above. **Update flow**: a new build installs a new worker
  that waits; the page shows "New version available — Reload"; Reload posts `skip-waiting` and reloads on
  `controllerchange`. The page checks for updates when it becomes visible and hourly.
- Sign-out posts `clear` to the worker and deletes the `ab-*` caches (and the offline store, below).
- Service workers, the camera and WebCrypto need a **secure context**: HTTPS or localhost. On a LAN use the installer's
  HTTPS option and trust its certificate authority on the phones: `docs/admin/phones.md`.

## Offline entry

### Turning it on

App settings > **Works offline (entry)** (`AppDef.offline.entry`, additive contract field). While such an app is open
(`registerOfflineApp` from `RunApp`), its data sources are *offline tables*.

### Writes (the outbox)

`remote.ts` asks the hook before each create, update and attachment upload of an offline table: `divert` (we are
offline, or an earlier item of the same row still waits) or, after a network failure, `accepts`. Then the write goes to
the outbox instead of failing; its optimistic row stays visible in this session. `src/phone/offline/outbox.ts`:

- items in strict order (sequence number); an item waits while an earlier item of the same row is unsent;
- every send carries `Idempotency-Key: <item id>.<revision>`; the server answers a repeated key with the first answer
  and writes nothing; creates carry their client-generated row id;
- network failure / 5xx / 429 / 401: the item stays waiting and the replay stops (retried when the connection returns,
  after a queued write while online, and every 30 s);
- 409 version conflict: `conflict` with the server's current row; **Keep mine** resends against the new version,
  **Use the server's** drops the change;
- other 4xx (validation rules, required, permissions): `rejected` with the message; **Fix and resend** edits the
  values (new key revision), **Discard** drops it. Server rules always win.
- The status strip under the shell (`ConnectionBar.tsx`, in the page flow so it never covers an app's buttons) shows
  "You're offline", "N waiting to send" and the per-item panel.
- Not offline: deletes, approvals, flows, connector actions. They fail with the usual "Could not reach the server".

### Tables kept on the device ("available offline")

- Contract: `AppDef.offline.tables?: OfflineTableDef[]` (`{ table, filter?, maxRows? }`, additive and optional, in
  `src/contracts.ts`); edited in App settings under **Works offline (entry)** > **Available offline**
  (`src/studio/AppSettings.tsx`). Only data sources of the app count (`normalizeOfflineTables`); the row cap is 2,000
  when blank and at most 10,000 (`src/phone/offline/tables.ts`).
- The filter is a formula condition (`Status <> "Closed"`, `owner = User().Id`). `RunApp` compiles it with the same
  translator as every formula (`analyze` of `=Filter(T, <filter>)`, with `User()` from the session); it must translate
  completely to a server condition. If it does not, the table is not kept and the reason is shown; it never falls back to
  "all rows".
- Download (`syncTables` in `offline/index.ts`): when the app opens online, on pull to refresh, and again when the
  connection returns after a failed download. `POST /api/v1/query` with the plan `{ table, filter, count, page }` in pages of
  500 up to the cap, **as the signed-in user through the normal query endpoint**: row-level and column-level security
  apply exactly as online (the server returns what this user may read, nothing else). No new route, no schema change.
  Progress shows in the status strip ("Getting Parts ready for offline use: 1,000 of 1,500"); when the cap cut the data,
  a dismissible plain message says how many of how many rows are kept and that offline lists show only those.
- Storage: one sealed record per table and environment (`snap:<environment>:<table>`) in the `cache` store, holding the
  user id, the environment, the rows (wire format), the server's total and whether a filter applied. One budget for
  everything in `cache`: 25 MB (`CACHE_CAP_BYTES`, unchanged; reason below). Beyond it the least recently used answers
  are evicted first, then the least recently used tables; one table may use at most 80 % (20 MB), else it is not kept and
  the message says so. 10,000 rows of a typical table are 1-3 MB sealed, so the cap, not the budget, is the usual limit.
  The budget was not raised: phones evict "best effort" storage under pressure, and a bigger cache makes a stolen
  unlocked phone expose more; raise it only with a measured need.
- Answers (`answerFromSnapshot` in `src/platform/offline-hook.ts`, called by `remote.ts` `cachedRead` after a network
  failure and a miss of the exact-answer cache): the reference executor (`src/fx/query/reference.ts`, demo mode's) runs the
  plan over the kept rows and the result goes back to the query cache in the wire format, so Dropdown / ComboBox
  type-ahead (search plans), lookups (`LookUp`, `First(Filter(...))`), counts and simple lists over those tables work
  offline. Whole-table loads (`/data/:t/query`) are answered with the kept rows too. Answers from kept rows that the cap
  or the filter cut are marked `truncated` (the existing "partial data" flag). A plan the executor cannot run fails with
  "Could not reach the server" as before.
- Never another user's rows: the store is per user (database name and key), and every read checks the sealed user id
  and environment against the session. Wipe, epoch change and sign-out delete the database, so the kept rows go with it.

### Form drafts across reloads

- `src/phone/drafts.ts` (keys, restore decision, note text; pure parts tested) and the store functions `drafts.save /
  load / remove` in `offline/index.ts`; the React side is in `src/controls/inputs/Form.tsx`. `RunApp` provides
  `DraftScope` (app id, node -> screen), so drafts exist only in a running app in server mode (not in the Studio, design
  mode or demo mode).
- Kept in the user's encrypted store (`meta` store, key `draft:<app>|<screen>|<form>|<table>|<record>`; record =
  `id:<row id>` for Edit, `new:new` for New): values (Dates kept), the record version the edits started from, and the
  pending files (photos, signatures) sealed one by one, at most 8 MB per draft (larger ones are left out and the note
  says so). In clear: only the time (for the 14-day expiry and the limit of 50 drafts per user). Never localStorage.
- Written 600 ms after the last change while the form has unsaved changes, and at once on `visibilitychange: hidden` and
  `pagehide` (a phone may discard a background tab). Deleted when the form is saved (also when the save went to the
  outbox), on Discard, when the values are put back (ResetForm), when the form moves to another record, when the form
  is left inside the app (another screen, the app tab closed: not an accident), on sign-out and on wipe (database
  deleted). Save / load / remove of one key run in order (a late save cannot land after a remove).
- Restore (once per load, only into a form nobody typed in yet, same mode): the values and pending files come back with
  a "Draft restored (kept on this device at 10:42)" note and a **Discard** button. Edit drafts keep the version they
  started from as the save's base: if the record changed on the server since, the note says so and the save is refused
  with 409, which opens the form's existing conflict panel (reload theirs / keep mine). A draft is never put silently over
  a newer record.
- Needs the offline key, so a browser session that has signed in and fetched it (the same as the outbox).

### Server side (`server/core/offline.ts`)

- `idempotentWrite`: claims the key in the existing `ab_action_idempotency` table (per environment; hash of environment,
  user and key; kept 24 h; a claim left running for 60 s may be retaken). Wired into `POST /data/:table/rows`,
  `PATCH /data/:table/rows/:id` and `POST /attachments`. A refused write releases its key.
- `POST /api/v1/offline/key { deviceId }`: `HMAC-SHA256(K, "appbuilder-offline-v1" | user | device | epoch)` where K is
  derived from the install's secret key (never the secret key itself). Nothing is stored.
- `POST /api/v1/offline/wipe { userId? }`: raises the user's epoch in `ab.user_settings` (key `offline`), audited as
  `offline.wipe`. Own devices, or any user's for administrators (Users > ... > Wipe phone and offline data; Settings >
  Data and privacy > Wipe phone and offline data).
- No new tables; `SCHEMA_VERSION` unchanged.

### The store

- One IndexedDB database per user (`appbuilder-offline-<userId>`), stores `outbox`, `cache`, `meta`.
- AES-256-GCM (WebCrypto), random 96-bit IV per record, key imported non-extractable. The key text is kept in memory and
  `sessionStorage` only; the device id (not secret) in `localStorage`.
- In clear: item kind, table, row id, status, times and the sequence (to count and order without the key); the cache
  index (table names, sizes, times; record keys name the environment and table); draft keys (app, screen, form, table,
  record id) and their times. Sealed: values, files, error messages, server rows, cached answers, the rows of tables kept
  for offline use, drafts and their files.
- `meta.epoch` and a sealed check record: a different epoch or a check that does not decrypt deletes the database.
- Read cache: answers of `POST /query` and whole-table loads over offline tables are sealed into `cache` (25 MB,
  least recently used evicted beyond it); when the server cannot be reached the same request is answered from it. Plans
  never seen before (a new search, another filter) fail with "Could not reach the server." (the formula shows its
  error: never other data).
- Cold start without a connection (`OfflineStart.tsx`): a browser that used the server before shows "No connection to
  the server" instead of falling back to demo mode, and reloads when the server answers. The outbox is kept and sent
  after the next sign-in/connection.

### Threat model

- **A stolen unlocked phone with the browser open**: the thief has the session; they can see what the user can see,
  online and in the cache. Encryption does not help here. With "available offline" tables this now includes, **even with
  the network off**, every kept row of those tables (up to the cap, as this user may read them, up to 25 MB in total) and
  any unsaved form drafts (up to 50, 14 days, with their photos and signatures); before, only answers the screens had
  loaded. Makers should keep offline tables narrow (a filter such as `owner = User().Id`, a low cap). Mitigations: short
  session lifetime and two-step verification (Admin console), and **Wipe phone and offline data**: the next time the
  phone connects its store is deleted (kept rows and drafts included); a session can also be ended from Users > Sessions.
  A phone kept offline after the theft keeps its data readable for as long as that browser session lives.
- **A lost phone with the browser closed, or storage read out of the device**: the store is encrypted; the key is only
  in that browser session's storage and on the server (derivable). Without a valid session nobody gets the key; after a
  wipe the server never issues it again.
- **A shared phone**: each user has their own database and key; sign-out deletes the user's store (it asks first when
  changes are waiting).
- Not protected: an attacker with the running, signed-in browser; malware on the phone; screenshots.

### Limits (honest)

- Opening an app with no connection after the browser session ended (cold start) does not work: the key is session-only.
- Queued rows created offline are visible in this session only; after a restart they show in the outbox panel, and in
  lists once sent.
- "Available offline" tables: only the kept rows (cap, filter) answer offline; counts and searches cover only those
  (answers are marked partial). The rows are as fresh as the last download (open, pull to refresh); live updates do not
  change them. Rows created offline appear in the session's lists as before, not in the kept rows. Lookup paths
  (`via`, `Customer.Name = ...`) offline need the target table kept too, else the plan fails offline. Kept rows of a table
  removed from the app's list stay until evicted or the store is deleted. The cap message is shown again on the next open
  (a dismissal lasts for the page session).
- Form drafts: kept only in a browser session that has the offline key (as the outbox); a draft of a form left inside the
  app is deleted on purpose (only reloads and discarded tabs are covered); restored only into a form nobody typed in yet.
  Drafts are per user, not per device tab: two tabs editing the same record share one draft (the last write wins).
- The Back gesture: only the picker sheets and phone-width Dialog / Sheet UI components; the outbox panel and other Radix
  sheets of the shell are not covered.
- Not offline: deletes, approvals, flows, connector actions.

## Connectivity

- Reads that change nothing (`GET`, `POST /query`, `/data/:t/query`, `/attachments/resolve`) are retried twice with
  backoff (about 400 ms and 1.2 s, with jitter) after a network failure or a 502-504, unless the browser says it is
  offline (`src/platform/offline-hook.ts`, `remote.ts` `call`). Writes are never retried by `call`.
- "You're offline" shows for every user (not only offline apps); the live socket's existing degraded mode ("Live
  updates paused") is unchanged.

## CSP and headers

**No CSP directive changed.** The service worker is same-origin script (`script-src 'self'`; `worker-src` falls back to
it), the manifest is same-origin (`default-src 'self'`), the camera stream needs no `media-src` (`srcObject`), photos and
QR codes are `blob:`/inline SVG (`img-src 'self' data: blob:` already). No Permissions-Policy header is sent, so camera
and geolocation are allowed for the page itself and (with `X-Frame-Options: SAMEORIGIN`) never for other sites' frames.
`server/core/pwa.test.ts` pins the CSP string.

## Tests

| What | Where | Proves |
| --- | --- | --- |
| Outbox: order, idempotency (lost answer), crash/restart, locked store, conflict (keep mine / use server), rejection (fix and resend), 5xx/401 pause, shared replay, encryption at rest | `src/phone/offline/outbox.test.ts` | the outbox rules |
| 1D decoder against generated barcode images (scaled, noisy, blurred, reversed), checksum/quiet-zone rejection | `src/phone/scan/decode1d.test.ts` | the fallback decoder |
| Layout rule, device classification, keyboard inset, connectivity transitions, read retries, wedge, debounce, EXIF/orientation/size maths, nearest target, install platform, start route, Device()/Location(), Form New-mode starting values, the touch matrix over the registry, `touch-logic.ts` (option filter, native date/time conversion and range, NumberInput keypad and comma, card plan and `CardColumns`, overlay placement, sheet drag, save-bar pinning, chart touch sizes) | `src/phone/phone.test.ts` | pure logic |
| Signature maths (pad rect, simplification, smoothing, ink, export size bounds), the Back stack against a fake history (normal close, Back, nested, kept open, navigation), offline tables (normalising, cap, filter compiling incl. `User()` and refusals, download plans, cap message), answers from kept rows (search, single, paging with cursors, counts, wire dates, refusal), draft keys / restore decision / note, Patch file tokens | `src/phone/capture.test.ts` | pure logic of the offline and capture package |
| Icons (PNG decoded), colours, manifest, service worker source, CSP unchanged, offline key derivation, idempotency key validation | `server/core/pwa.test.ts` | server side |
| End to end in Chrome's phone emulation | `scripts/exit-check/p2-phone.mjs` | the exit check (below) |

The exit script (120 checks; section E, 51 checks, covers the touch controls below; run only that part with `EXIT_ONLY_TOUCH=1`): sign-in at 360 px, manifests and icons, service worker registered and caching no data,
opening the app from its start address, fluid layout, Device(), a camera scan of a Code 128 barcode from Chrome's fake
camera (a generated Y4M video; our decoder, because headless Chrome on Linux has no BarcodeDetector), keyboard wedge,
the 44 px touch area by a real touch tap, an offline save with a photo (2 items waiting, visible), sent exactly once when
back online with the photo resized to 1600 px, a reload while offline (cold start page, then sent once), slow 3G,
server idempotency, the service worker update flow, the shell at 360 and 412 px, the touch audit, then in emulation: the
Dropdown/ComboBox bottom sheets (44 px rows, search, lifted by `--kb`, Done, tap-outside and drag close), the native
date / range / time fields and their value contract, NumberInput keypad / sign / comma, Alert dismiss 44 px, Dialog and
Sheet as bottom sheets, DataTable cards (CardColumns, selection, sort), Chart and Visual taps, the pinned Form save bar at
360 x 520 with and without `--kb`, desktop unchanged (popovers, table, centred dialog, no history entry for a popover);
then section F (25 checks; run only that part with `EXIT_ONLY_F=1`): an "available offline" table of 2,600 rows with a
filter and a cap of 1,500 (downloaded, cap message, sealed and counted in the budget; offline, new searches answered
from the kept rows and rows beyond the cap absent), a form draft restored after a reload (sealed, not in local or
session storage; Discard), the SignaturePad (finger strokes, no scroll or pull to refresh, Patch with FileToken: a
bounded 3:1 PNG on the server, Reset) and a Form signature field saved offline (2 outbox items, sent once), an offline
update in conflict with a server change (Keep mine; Use the server's), an offline create refused by a validation rule
("rejected" with the server's message; Fix and resend; Discard), Android Back by `history.back()` on a picker sheet (closes,
stays in the app), a normal close leaving no history entry, and a phone-width Dialog running OnClose; sign-out clearing
everything, the device wipe. 120 checks in total.

**Not proven here** (manual, `docs/dev/phone-test-script.md`): real Android and iOS devices, iOS Safari at all, the
native camera of `capture`, every touch control above on a real phone (the native pickers, the sheets with a real on-screen keyboard, iOS `visualViewport` behaviour), QR codes and the BarcodeDetector path, real torch, real keyboard behaviour, real Wi-Fi
dropouts and packet loss, installing to the home screen, the LAN HTTPS certificate on phones, signing with a real finger
or stylus (palm rejection, pressure, iOS Safari's pointer events), the real Android Back gesture and predictive back,
a real tab discard by the phone's memory pressure (the exit script reloads instead), IndexedDB quota and eviction on a
full phone with 25 MB of kept rows.

## Studio preview and Check on phone

`src/studio/Preview.tsx` (`DeviceFrame`) lays a phone or tablet app out with `usesFluidLayout` / `fluidSurface` for the frame's screen size and turns on `setTouchPreview` while shown. It does not use `RunSurface`, which measures its area with `getBoundingClientRect` (scaled by ancestor transforms). Size and scale maths: `src/studio/phoneFrame.ts` (unit-tested). `src/studio/CheckOnPhone.tsx` shows a QR code of the app's phone start address, reusing `QrSvg` and `appPhoneUrl`. Neither has been clicked through in a browser yet.
