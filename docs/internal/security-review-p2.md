# Security review of Phase 2

Internal review of everything Phase 2 added (the phone web app and its offline store, PDF and Word generation, dashboards
with view tokens and snapshots, templates, auto apps, WhatsApp) and of two cross-cutting changes made the same day
(the router's `lingerClose`, the live hub's re-check fix), done on 20 Nov 2026 by reading the code and then attacking it
with tests. It is a review by the people who built it, not an outside audit, not a penetration test by a third party and
not a certification. The format follows [the Phase 1 review](security-review-p1.md). Severity is for this product's
threat model ([security model](../admin/security-model.md#threat-model)): one organisation per install, trusted
administrators and makers, untrusted ordinary users, web pages, callers of webhooks and, new in Phase 2, people who
share a phone and anyone who can reach an install that the `--https domain` option put on the internet.

Tests named here: `server/core/security-p2.test.ts` (S-U, no database), `server/core/security-p2.integration.test.ts`
(S-I, PostgreSQL), `src/phone/security-p2.test.ts` (S-C, browser logic with an in-memory store). **Every fix below has a
test that was run against the code with the fix switched off and failed** (the fix was disabled in place, the test run,
the fix restored; the outputs are summarised under [Method](#method)).

## Method

1. Read the Phase 2 design (`docs/plan/p2-spec.md`, decisions D32 to D46), the dev documents (`phone.md`, `pdf.md`,
   `dashboards.md`, `auto-apps.md`, `templates.md`, `whatsapp.md`) and the code of each area, looking first at identity
   (who a request, job or token runs as), then at what is stored or cached and for whom, then at resource limits.
2. For each suspected weakness, a test that reproduces it through the public interface (HTTP, WebSocket, the offline
   hook the platform calls, the print engine's entry points).
3. Fix, then switch the fix off and confirm the test fails: S-U 6 of 6 finding tests failed without their fixes
   (P2-1 with the old "body first" order simulated: no answer within 3 s), S-I 5 of 5 (P2-3, P2-6 after the 60 s
   test timeout, P2-7, P2-8, P2-10), S-C 1 of 1 (P2-2 and P2-2b, each disabled separately).
4. The areas below without a finding have tests too where a regression would matter (marked "guard").

## Findings

| # | Area | What was tested | Finding | Severity | Status |
| --- | --- | --- | --- | --- | --- |
| P2-1 | Router (cross-cutting; item 8 of the scope) | A request that declares a 30 MB body to a maker route, without a session and as a non-maker; many such requests in parallel | **The router read and buffered the whole body before it checked the session and the route's sign-in level.** Anyone who can reach the server (on the LAN or, with `--https domain`, the internet) could make it hold up to 40 MB per request (solution packages; 25 MB app imports, 16 MB print templates) and run it out of memory with a few dozen parallel requests. | Medium (denial of service, no sign-in needed) | Fixed: the session and sign-in level are checked first, the body is read after; a refused body is discarded for at most 5 s / 64 MB (`lingerClose`, `server/core/router.ts`). S-U "FINDING P2-1" |
| P2-2 | Offline store on a shared phone | Ana works offline (a queued change, a kept answer), then Ben signs in on the same page without a reload (a session that ran out, or the Settings / pending-password sign-out buttons, which do not call `beforeSignOut`) | The previous person's store stayed `current` and unlocked: **the 30-second replay sent Ana's queued changes with Ben's session cookie** (written as Ben, with Ben's rights), offline reads of offline tables could be answered from Ana's kept answers, Ben's offline writes went into Ana's outbox, and Ana's outbox items were listed in Ben's status strip. | Medium (integrity and confidentiality between people sharing a device) | Fixed: every use of the store checks that it belongs to the person signed in now; the store is locked the moment the signed-in person changes (key out of memory and `sessionStorage`; sealed data stays for Ana) (`src/phone/offline/index.ts`). S-C "FINDING P2-2". Open: the other sign-out buttons should still delete the store (below) |
| P2-2b | Offline store, data in clear | What IndexedDB holds in clear | Kept answers were stored under the request text (`POST /query` + the plan as JSON), in clear as the record key and in the cache index: **filter values and search words** (a customer's name typed into a search box) were readable from the device without the key. The key also lacked the environment, so an answer from one environment could answer the same request in another. | Low | Fixed: kept answers are named `a:<HMAC-SHA-256>` of environment and request under a subkey of the offline key; old entries are dropped at unlock (`codec.ts` `name`, `index.ts`). S-C "FINDING P2-2" (2b part), "the keyed names" |
| P2-3 | Live hub re-check (cross-cutting) | A subscriber to a record's presence loses read access while the security check fails for another reason (database error, environment being restored: 503) | The fix of the day kept a subscription when the check failed for a non-refusal, which is right, **but never checked it again** until the next role, user or table change. Presence messages are not re-authorised per message, so the person kept receiving the names of people viewing that record (or, for a demoted administrator, "who is online") indefinitely. Table messages were not affected (re-checked per message). | Low | Fixed: a failed check is retried 5 s later and then with every minute's sweep until it succeeds (`server/core/live/hub.ts`). S-I "FINDING P2-3" |
| P2-4 | PDF images | A PNG that declares 20,000 x 20,000 pixels with transparency, under 1 KB of file | Only the file size (10 MB) was limited. pdfkit decodes PNGs with an alpha channel (or a palette with transparency) into memory, 4 bytes per pixel, synchronously in the one server process: **a small image in an image column that a template prints (any person who may upload a photo) could take gigabytes and stall or kill the server for everyone.** | Medium (denial of service by an ordinary user) | Fixed: PNGs over 40 megapixels are left out with a warning (`print/images.ts` `MAX_PNG_PIXELS`, `bind.ts`); JPEGs are embedded without decoding. S-U "FINDING P2-4" |
| P2-5 | Word templates | A 20 MB "document.xml" of one letter, deflated to under 200 KB | PizZip unpacks a .docx in memory and nothing checked the ZIP first (the workbook importers use `zip-guard.ts`, the Word path did not). **Templates also arrive in solution packages, which skip the upload check entirely**, and every generation (by any person who may print) unpacked the file again. | Medium (denial of service; planting needs a maker) | Fixed: the ZIP directory is checked on upload and before every generation: 128 MB unpacked, 100x compression, 2,000 parts, no ZIP64 (`print/docx.ts` `DOCX_LIMITS`). S-U "FINDING P2-5" |
| P2-6 | Generated-file tokens | `GET /print/files/gen_<made up>` and someone else's token | The reader waited up to **90 s for any token that did not exist, polling the database every 150 ms** (about 600 queries), and checked the creator only after the wait. Any signed-in person could hold requests and load the database at will; a write naming a made-up token in a file column waited the same 90 s inside the write. | Low (authenticated resource holding) | Fixed: a token that does not exist is waited for at most 10 s (the GeneratePdf request that registers it may arrive just after the write that uses it), a malformed one not at all, someone else's at once (404 / 422) (`print/service.ts` `readyFile`). S-I "FINDING P2-6" |
| P2-7 | App install manifests | `GET /pwa/apps/:id/manifest.webmanifest` for an app the person may not run, and for no app | 403 for an existing app, 404 for none: **an oracle for which app ids exist** (the name was not leaked). | Low | Fixed: the same 404 for both (`server/core/pwa.ts`). S-I "FINDING P2-7" |
| P2-8 | Dashboard snapshots | A viewer (no maker rights) subscribing themselves with `cron: "* * * * *"`; "run now" in a loop | Any person who may open a dashboard could schedule snapshots of it **every minute, any number of them**, and enqueue "run now" jobs without limit; each run computes every tile and draws a PDF per recipient. | Low (authenticated load and mail) | Fixed: a snapshot runs at most once an hour (a cron naming more than one minute is refused); a recipient's "run now" at most once a minute per snapshot; owners and administrators are not limited (`dashboards/snapshots.ts`). S-I "FINDING P2-8" |
| P2-9 | WhatsApp number forms | Different writings of one number against the opt-in store | `"+44 (0)20 ..."` / `"+91 (0) 98..."` (the bracketed trunk prefix, common in contact lists) became `+4402...` / `+91098...`: **a second "number" for the same phone.** An opt-in recorded in that form survived the person's STOP (recorded for the number Meta reports), and messages to that form kept being sent. | Low | Fixed: `(0)` after an international prefix is dropped (`whatsapp/phone.ts`). S-U "FINDING P2-9", S-I "FINDING P2-10" (the same number in two forms). Residual: `+91 0 98...` without brackets stays distinct |
| P2-10 | WhatsApp consent records | The action "Record an opt-in or opt-out" with `source: "inbound keyword"` | A flow could record consent **as if the person had written START to the number** (the source that only the signed webhook should produce), so the opt-in history could not tell a maker's record from the person's own message. | Low | Fixed: the action refuses that source and its schema no longer offers it (`whatsapp/provider.ts`, `defs.ts`). S-I "FINDING P2-10". The Admin console still offers it to administrators (below) |
| P2-11 | WhatsApp: the HTTP connector refusal | Other names of Meta's Graph API in an HTTP connection's allow-list | Only `graph.facebook.com` (and patterns covering it) and `graph.whatsapp.com` were refused; **`b-graph.facebook.com`, `graph.facebook.net`, `graph.fb.com` and the rest of Meta's domains were not**, so the "no way around the opt-in check" statement did not hold for a maker with an HTTP connection and a token. | Low | Fixed: every host of `facebook.com`, `facebook.net`, `fb.com`, `fbcdn.net`, `fbsbx.com`, `whatsapp.com`, `whatsapp.net` and patterns covering one (`whatsapp/graph.ts`). S-U "FINDING P2-11". Residual: an IP address of Meta |
| P2-12 | PDF metadata | A title from data and a person's name as author with XML in them | The Info dictionary is escaped by pdfkit, but **pdfkit writes the same values unescaped into the XMP metadata stream**: a record value in the title formula, or a user's display name, could add or forge XMP elements (rights, creator) that document managers show. | Low | Fixed: `<`, `>`, `&` become look-alikes and control characters go before pdfkit sees the values (`print/pdf.ts` `metaText`). S-U "FINDING P2-12" |

## Areas reviewed

| Area (scope item) | What was tested or read | Result |
| --- | --- | --- |
| 1. Service worker and PWA | Cache rule (only `/`, icons and manifests; `/api/` never from the cache; GET and same origin only), clearing on sign-out and wipe, update flow without `skipWaiting` until the person chooses, scope `/` via `Service-Worker-Allowed`, `?app=` start address (ids only), icons deterministic from validated parameters (no app data), CSP unchanged. S-U "the service worker answers only ...", S-C "the ?app= start address" (guards) | Fixed P2-7. Read only: the real worker in browsers (the exit script `p2-phone.mjs` covers it, not run here) |
| 2. Offline store | Key issuance (own user only, device id format, epoch; a cookie session is required, `userId` in the body ignored), wipe (own, administrators for others), idempotency per user and environment (two people with one key write two rows; a retry replays only one's own answer), user switch on one page, what is in clear, drafts (user id inside the sealed body, checked) | Fixed P2-2, P2-2b. Accepted: the 60 s retake, 24-hour replay of a stored answer, no AAD (residual risks). S-I "idempotency keys are per person", "offline keys" (guards) |
| 3. PDF generation | Identity per path: person, draft preview (always the caller), flow (`fixedIdentity`), scheduled report and snapshot (each recipient), bulk zip and merged (the starter, re-checked at run time), timeline Documents, Word; hidden columns blank; tokens (format, creator, claim, wait, 24 h); data as formulas (values are never parsed: text parts, rich-text placeholders in a private-use range, Word tags filled as escaped text), file names (`\ / : * ? " < > |` and controls removed: no zip slip), chart labels through `svgops.ts`, metadata, images, Word ZIPs | Fixed P2-4, P2-5, P2-6, P2-12. Accepted: service-account templates print any record (below). S-U "chart labels ...", "PDF metadata ..." (guards) |
| 4. Dashboards | Batch endpoint = Query v2 as the viewer (hidden columns refused in select, filter, sort, group and aggregate by `data.ts`; tested in the Phase 0 review); cache key: environment, user, row predicate, visible columns, plan; view tokens (not an API key on other routes, plans refused, other dashboard 404, other environment 403, a cookie beside the token changes nothing, revoked / expired / disabled account / lost access stop it, rate limits, SHA-256 at rest, fragment-only address, `credentials: 'omit'`); `checkChoices` (filters, options, cross-filter tile and column, value types, ranges); snapshots per recipient, unsubscribe links signed with their own key; pins (only ids, "not available" says nothing); ALM; drill-through (encoded values, app id pattern) | Fixed P2-8. Accepted: definitions readable by viewers, ALM replaces another owner's dashboard (below). S-I "a dashboard view token is not an API key ...", S-U "checkChoices", S-C "drill-through" (guards) |
| 5. Templates | No route takes a package (built-in catalogue only; integrity by digest manifest); binding: created names must be identifiers, clashes refused; formulas rewritten through the parser (a hostile mapped name stays one quoted identifier: S-U guard); mapped tables only read and written as data, events and sample rows only on created tables; rule 8 (roles, run-as-system events, deleting tables with data: administrators; secrets stripped); plan token re-checked at apply; uninstall removes only what the register lists and keeps tables others use; upgrade needs an administrator (solution upgrade rule) | No finding. Read, not attacked by test: upgrade and uninstall races (residual) |
| 6. WhatsApp | Fixed host and policy (no redirects, private networks refused, pinned DNS), Meta errors not passed verbatim, secrets never in answers (existing tests), webhook: signature over the raw body with `timingSafeEqual`, body read after the rate limit and only to 512 KB, each signature once (8 days), events older than 7 days ignored, another number's events ignored; STOP always applies, START only when newer; opt-in on every send path including notifications and retries (existing `whatsapp.integration.test.ts`); number normalisation; inbound-triggered flows (run as the flow's own identity; the inbound text is data) | Fixed P2-9, P2-10, P2-11. Accepted: handshake 404/403 tells whether a connection id exists; makers may record opt-ins (D43) |
| 7. Auto apps and phone UI components | Generated formulas with hostile table and column display names (S-C guard: every formula parses, injected calls stay inside text literals); `Patch` with file tokens (claim checks above); signature pad and photo uploads go through the attachment route (size and type per column, sandboxed downloads); scanner wedge input and QR results are text values; `Device()` / `Location()` read in the browser after its own permission prompt | No finding (read; the UI component code was not changed, see below) |
| 8. Cross-cutting | `lingerClose` (answer first, discard at most 5 s or 64 MB, never buffered; many parallel refused uploads cost bandwidth, not memory); the live re-check fix | Fixed P2-1, P2-3 |

## Findings in areas this review could not change (proposed fixes)

- **Sign-out buttons that skip `beforeSignOut`** (`src/portal/Settings.tsx` lines 259 and 301, `src/portal/Auth.tsx` lines
  556 and 659): they call `platform.auth.logout()` directly, so the phone's offline store is not deleted (since P2-2 it is
  locked and stays sealed). Proposed: call `beforeSignOut((t) => window.confirm(t))` first, as `src/portal/Profile.tsx`
  does, so a shared phone keeps nothing after any sign-out.
- **Admin console WhatsApp opt-in form** (`src/portal/AdminWhatsapp.tsx` line 85) offers the source "Inbound keyword" to
  administrators. The server still accepts it there (administrators are trusted), but it lets a manual record look like
  the person's own message. Proposed: remove the option, then refuse it in `POST /whatsapp/optins`.
- **Device(), Location(), Scan, QR, signature pad** (`src/runtime`, `src/controls`, read only): no finding. A
  hardening idea for the owners of that code: cap the signature pad's PNG size before upload (the server caps by column
  anyway).

## Residual risks (carried into the security model page)

- **Service-account print templates**: every signed-in person can print every record of the template's table that the
  service account reads, including records they cannot see (by design, `print.integration.test.ts` "Bo prints Ada's
  inspection"; audited per generation). Proposed for later: an option "the caller must be able to read the record".
- **Idempotency (offline replay)**: a claim left "running" for 60 s may be taken again, so a write that takes longer than
  60 s can run twice when the phone retries (creates are protected by their client row id; an update or upload can apply
  twice). A retry within 24 h replays the stored answer even if the person's access changed since (only to that person).
- **Offline store**: sealed records are not bound to their record key (no additional authenticated data), so someone who
  can write the browser's storage can swap sealed records between keys of the same store; outbox metadata and draft
  keys are in clear; the device id is not secret, so the key depends on the session (a stolen unlocked phone has it).
- **Opt-ins**: a maker's flow can record an opt-in again after the person wrote STOP (attributed, D43); `+91 0 98...`
  without brackets is a different number from `+91 98...`; Meta's Graph API by IP address is not refused for HTTP
  connections; whoever holds the access token outside Appbuilder is not bound by its opt-in check.
- **Dashboards**: a definition (tables, columns, filter constants) is readable by everyone who may open the dashboard
  and by its kiosk tokens; results may be 20 s old after a sharing change (D34); importing a solution replaces the
  definition and viewer roles of a dashboard with the same id whoever owns it (makers are trusted, as for apps); kiosk
  tokens are in the screen's address bar and history (D40).
- **Requests**: routes without a session (sign-in, webhooks, view tokens, unsubscribe) still read their small bodies
  (2 MB at most) before any check; a client can open many connections, each holding up to 5 s of discarded upload after
  a refusal; there is no per-address connection limit in the server (Caddy's limits apply behind the HTTPS option).
- **WhatsApp webhook**: the handshake answers 404 for an unknown connection and 403 for a wrong verify token, so it tells
  whether a connection id exists in an environment (the token is not guessable from it).
- **Templates**: between an uninstall's plan and its apply, rows written into an "empty" table are deleted with it (a
  window of the request's duration).
- Scheduled reports (Phase 1) still accept a cron of every minute for makers; P2-8 limits snapshots only.

## Not reviewed / needs an outside reviewer

- **Real devices**: no real Android or iPhone, no real home-screen install, no real camera or barcode scanner; browser
  behaviour (IndexedDB eviction, `sessionStorage` lifetime, service worker updates) is as documented by the vendors and
  checked with headless Chrome by the exit scripts, which were not run for this review.
- **The real Meta API**: everything is against the fake Graph API (`mock-graph.ts`); Meta's real error shapes, number
  normalisation on its side, webhook retries and signature details are unverified (as D43 says).
- **Cryptography**: the offline key derivation (HMAC), AES-GCM use, the keyed names, the signed unsubscribe links and the
  template digest manifest were reviewed by developers, not by a cryptographer.
- **Multi-tenant isolation**: does not exist (one organisation per install, D45 / D46). Nothing here says anything about
  a future multi-tenant cloud.
- **Load and denial of service at scale**: only single-request limits were tested; no load test, no slow-loris test
  against Caddy, no measurement of how many parallel PDFs, snapshots or dashboard batches one server survives.
- **Third-party libraries** (pdfkit, fontkit, PizZip, docxtemplater, jsQR, ws): used as they are; not fuzzed (P2-12 was
  found by reading pdfkit's XMP code; there may be more).
- **The UI component code** (`src/controls`, `src/runtime`, `src/autoapp`) was read, not changed and only lightly tested.
- An outside review is still due before the pilot goes beyond one company (master plan section 5); hosted testers
  started before it are a risk the owner accepted (D46).
