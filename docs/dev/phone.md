# Phone experience (P2 package A)

How Appbuilder apps run on phones: the layout rule, touch handling, the installable web app (PWA), the scanner and
camera, the offline entry outbox, connectivity, and what is and is not tested. The code is in `src/phone/` (client),
`server/core/pwa.ts` and `server/core/offline.ts` (server), with small hooks in `src/platform/remote.ts`,
`src/runtime/RunSurface.tsx`, `src/runtime/RenderNode.tsx` and `src/runtime/evaluator.ts`.

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

### Touch matrix summary (83 UI components plus the Screen)

| Status | Count | Meaning |
| --- | --- | --- |
| works | 46 | usable by touch as it was (display-only UI components count here; Chart was reviewed and needed no change) |
| fixed | 38 | changed for touch: P2-A (touch areas, nearest-target taps, tabs scroll, photo capture, scan components) and the touch-limitation package (bottom-sheet pickers, native date/time, NumberInput, Dialog/Sheet, DataTable cards, Form save bar, Alert, Visual, PrintButton) |
| limitation | 0 | none left as a matrix status; the remaining gaps are inside the notes (native pickers ignore Format/Use24Hour, no Android back-button handling for sheets, Form choice/lookup fields use the Radix select, nothing tested on a real phone) |

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
- In clear: item kind, table, row id, status, times and the sequence (to count and order without the key). Sealed:
  values, files, error messages, server rows, cached answers.
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
  online and in the cache. Encryption does not help here. Mitigations: short session lifetime and two-step verification
  (Admin console), and **Wipe phone and offline data**: the next time the phone connects its store is deleted; a session
  can also be ended from Users > Sessions.
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
- No "available offline" table setting with a row cap: lookups and dropdowns offline show only answers this device
  already loaded.
- Form drafts are not saved across accidental reloads.
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
| Icons (PNG decoded), colours, manifest, service worker source, CSP unchanged, offline key derivation, idempotency key validation | `server/core/pwa.test.ts` | server side |
| End to end in Chrome's phone emulation | `scripts/exit-check/p2-phone.mjs` | the exit check (below) |

The exit script (94 checks; section E, 50 checks, covers the touch controls below; run only that part with `EXIT_ONLY_TOUCH=1`): sign-in at 360 px, manifests and icons, service worker registered and caching no data,
opening the app from its start address, fluid layout, Device(), a camera scan of a Code 128 barcode from Chrome's fake
camera (a generated Y4M video; our decoder, because headless Chrome on Linux has no BarcodeDetector), keyboard wedge,
the 44 px touch area by a real touch tap, an offline save with a photo (2 items waiting, visible), sent exactly once when
back online with the photo resized to 1600 px, a reload while offline (cold start page, then sent once), slow 3G,
server idempotency, the service worker update flow, the shell at 360 and 412 px, the touch audit, then in emulation: the
Dropdown/ComboBox bottom sheets (44 px rows, search, lifted by `--kb`, Done, tap-outside and drag close), the native
date / range / time fields and their value contract, NumberInput keypad / sign / comma, Alert dismiss 44 px, Dialog and
Sheet as bottom sheets, DataTable cards (CardColumns, selection, sort), Chart and Visual taps, the pinned Form save bar at
360 x 520 with and without `--kb`, desktop unchanged (popovers, table, centred dialog); sign-out clearing everything,
the device wipe.

**Not proven here** (manual, `docs/dev/phone-test-script.md`): real Android and iOS devices, iOS Safari at all, the
native camera of `capture`, every touch control above on a real phone (the native pickers, the sheets with a real on-screen keyboard, iOS `visualViewport` behaviour), QR codes and the BarcodeDetector path, real torch, real keyboard behaviour, real Wi-Fi
dropouts and packet loss, installing to the home screen, the LAN HTTPS certificate on phones.

## Studio preview and Check on phone

`src/studio/Preview.tsx` (`DeviceFrame`) lays a phone or tablet app out with `usesFluidLayout` / `fluidSurface` for the frame's screen size and turns on `setTouchPreview` while shown. It does not use `RunSurface`, which measures its area with `getBoundingClientRect` (scaled by ancestor transforms). Size and scale maths: `src/studio/phoneFrame.ts` (unit-tested). `src/studio/CheckOnPhone.tsx` shows a QR code of the app's phone start address, reusing `QrSvg` and `appPhoneUrl`. Neither has been clicked through in a browser yet.
