# Security review of Phase 3 and the hosting phase

Internal review of everything added since 0.7.0 (chat, notes and tasks, the flow and approval changes, solution
templates and packs, balances, Query v2 lookup sort and the removal of the v1 route, hosting: the read-only gate,
`__Host-` cookies, the locked public URL, the CLI, the licence client and service, seat passes, the connection-host
re-check; and this week's client hardening), done on 21 Nov 2026 by reading the code and then attacking it with tests.
It is a review by the people who built it, not an outside audit, not a penetration test by a third party and not a
certification. Nothing here says the product is secure or compliant. The format follows
[the Phase 2 review](security-review-p2.md). Severity is for this product's threat model
([security model](../admin/security-model.md#threat-model)) and, for hosting, the fleet threat model
([hosting spec](../plan/hosting-spec.md#threat-model-for-the-fleet)): one organisation per install, trusted
administrators and makers of that organisation, untrusted ordinary users, web pages and callers of webhooks, and, new
with hosting, a customer's administrator who must not reach anything outside their own install.

Tests named here: `server/core/security-p3.test.ts` (S-U, no database), `server/core/security-p3.integration.test.ts`
(S-I, PostgreSQL), `src/components/security-p3.test.ts` (S-C, browser logic). **Every fix below has a test that was run
against the code with the fix switched off and failed** (the fix was disabled in place by a text replacement, the test
run, the file restored byte for byte; see [Method](#method)).

A **second pass** the same day fixed P3-6 and attacked, with tests, what the first pass had only read or not covered
(chat, notes and tasks sharing, balances, lookup sort, the licence service, client parameters); packs were read again
but not attacked. Its findings are P3-11 to P3-19 below, and the [Coverage](#coverage-both-passes) section is rewritten for
both passes.

## Summary

**Second pass.** P3-6 is fixed (both database connectors connect to the checked address and re-check every later
connection). New: four fixed (three Low, one informational), two open (Low: MySQL TLS does not check the host name,
P3-15; a pack upgrade does not single out a role whose access widens, P3-16), three accepted. Held up against what was
tried: chat's member, file, search, export-token and retention rules, read and team shares, the balance invariant over
every write path tried, the lookup-sort tie rule, the licence service's limits and uniform refusals, the kiosk and start
address parsing. The weak spots were again old rules meeting a new feature: moderation could remove the export
announcement, an edit share could pass a note on by assigning it, and the task digest fell back to an owner without
asking whether the owner may still read the task.

**First pass.** Five findings fixed (one Medium, three Low, one informational), one Medium finding left **open** (DNS rebinding of
database connection hosts, P3-6: it needs a change in both database connectors; fixed in the second pass), four accepted by design. The chat
leak suite, the note sanitiser and the licence client held up against what was tried; the weak spots were where a new
feature reused an older path without the new rule: the balance refusal read names and quantities without row security,
the live socket and the sign-in answer built their user context without the seat pass, two families of maker routes
checked "administrator" in the handler instead of being flagged for the pass, and the outbound deny list compared names
only.

**Hosted testers before an outside review: what it means after this review.** In my judgement it is acceptable only as
what it is: a small number of known testers, with data they can afford to lose or have exposed, on installs the owner
watches, and with the open items below written into what testers are told. This review found nothing that lets an
ordinary user of one install read another install's data, but it did find a hosted safeguard (the deny list) that did not
hold as written, and one that did not hold until the second pass (P3-6, now fixed and tested in process with a fake
resolver, not with a real DNS server on the fleet), and it did not test the real Linux fleet at all. The three things I
would most want an outside reviewer to look at first:

1. **Install isolation on the real fleet**: per-install OS users, systemd sandboxing, PostgreSQL roles and `REVOKE`,
   Caddy routing and the Unix sockets, attacked from a customer administrator's account (database connections, HTTP
   connections, flows, SMTP, backups and restores), including P3-6 with a real DNS server.
2. **The licence scheme and the operator tooling**: the Ed25519 answer format, nonce and install binding, clock handling,
   the stored document, the key issuance and the licence service's endpoint (rate limits, uniform refusals, enumeration)
   by a cryptography specialist; the fleet tool's operator access path.
3. **The browser side of the collaboration features**: chat and note rendering, the rich-text and note sanitisers
   (mutation XSS in real browsers, Safari and Firefox included), the pop-out window channel, the service worker and the
   offline store on real phones.

## Method

1. Read the design (`docs/plan/p3-spec.md`, `docs/plan/hosting-spec.md` and its threat model, decisions D48 to D62), the
   dev documents of every area added since 0.7.0 and the code, first for identity (who a request, socket, job or flow
   runs as and which rule applies), then for what a refusal or a side channel tells, then for limits.
2. Enumerated every registered route (440 at the time of writing) with its options from the running router, and listed
   the write routes that a pass, the design flag or `auth: 'maker'` does not cover; read each handler's own check.
3. Probed the note and comment sanitisers with hostile shapes (deep nesting, floods, unclosed constructs, attribute
   splitting, entity-encoded schemes, namespace confusion) for time, size and output (a scratch script, then the guard
   tests below).
4. For each suspected weakness a test through the public interface (HTTP, WebSocket, the outbound policy's entry points,
   the client helper), then the fix, then the fix switched off: S-I P3-1 (balance viewer forced to "none"), P3-2 three
   times separately (the socket's pass, the sign-in answer's pass, the re-check on a pass change: the last one timed out
   after 10 s as expected), P3-3 (the `pass: 'full'` flags removed); S-U P3-4 (2 of 3 tests failed: the third checks the
   helper itself); S-C P3-5. Every one failed with its fix off and passed with it on.
5. Second pass: read the driver code in `node_modules` (pg 8.23.1 `lib/connection.js`, `lib/client.js`; mysql2 3.24.6
   `lib/base/connection.js`, `lib/connection_config.js`) for how each opens its socket, then wrote the P3-6 tests with a
   resolver that answers differently on its first and later calls (installed as the policy's resolver and as the
   process's `dns.lookup`) and a canary listener on 127.0.0.1. For the seven areas of the second pass, tests through
   HTTP, WebSocket, the job functions with an injected clock, and the licence service's handler over a recording fake
   database. Fixes switched off: P3-6 twice (the `stream` option in both connectors: S-U failed; the manager's lookup: S-I
   failed with 2 canary connections); P3-11, P3-12 and P3-13 in one run (the three tests failed, every other test of
   the file passed); P3-14 (the guard named the file).

## Findings

| # | Area (scope item) | Finding | Severity | Status |
| --- | --- | --- | --- | --- |
| P3-1 | Balances (5) | A refused movement stated the available quantity and the keys' lookup display names to anyone who may record a movement, also when they may read neither the balance table nor the lookup table | Medium (confidentiality, ordinary user) | Fixed |
| P3-2 | Seat passes (7) | The live socket and the sign-in answer built the user context without the pass (an Operator kept maker rights on the socket: Studio presence and lock, the maker shortcut of the table check); a pass change did not end live subscriptions | Low | Fixed |
| P3-3 | Seat passes (7) | An administrator holding an Operator pass could create, change, rotate and delete flow webhooks and connection custom actions (OpenAPI import included): those routes checked "administrator or owner / manage" in the handler and carried no pass flag | Low (licensing boundary; administrators are trusted) | Fixed |
| P3-4 | Hosting outbound policy (7) | `APPBUILDER_OUTBOUND_DENY` (which holds the install's own public host on a hosted install) was compared with the name typed only: the same address by its IP, an IPv4-mapped IPv6 form or any other name resolving to it was allowed | Low | Fixed |
| P3-5 | Client hardening (8) | `window.__abForceCrash` worked in the production build | Info | Fixed |
| P3-6 | Connection-host re-check (7) | The re-check at every use resolves the name itself, then the database driver resolves it again (and the pool later, on its own): a DNS server the administrator controls can answer the check with a public address and the driver with 127.0.0.1 | Medium (hosted: a customer administrator reaching the server's PostgreSQL port) | Fixed (second pass) |
| P3-7 | Flows, approvals "on behalf of" (3) | The step's `requester` formula is evaluated over trigger data; when a pack or maker takes it from a field users edit, the user chooses whose manager is asked (and who is excluded as requester) | Low | Accepted (makers choose the formula; built-in packs use `Trigger.Record.owner`, which ordinary users can only set to themselves or their own team) |
| P3-8 | formSubmitted trigger (3) | Each committed save that claims the Form starts the flow once per Idempotency-Key: a person who may save the Form can start it as often as they save | Low | Accepted (it is the feature; the flow's `maxRunsPerMinute` and the environment run limit apply) |
| P3-9 | Chat cards (1) | Any member can post a message with an approval, record, app or dashboard card naming anything | Info | Accepted (resolved per reader with the reader's rights; approval buttons call the inbox route with all its checks) |
| P3-10 | Rich-text sanitiser (1, 2) | `sanitizeRichText` cuts its output at 20,000 characters, possibly inside a tag | Info | Accepted (an unterminated tag at the end of `innerHTML` is dropped by the HTML parser; no place was found that concatenates a body into other HTML; email paths escape bodies) |
| P3-11 | Chat export (B1) | Moderation (`POST /chat/admin/messages/:id/moderate`, and "delete" on a report) removed ANY message, the system line "An administrator exported this conversation" included: an administrator could export a direct conversation and then wipe the announcement (a "message deleted" line and an audit entry stayed) | Low (administrators are trusted; the announcement is the members' only notice) | Fixed |
| P3-12 | Notes and tasks sharing (B2) | An edit share allowed changing `AssignedTo` / `AssignedTeam`: assigning a note or task gives the assignee read and write access, so an editor could pass someone else's note on to anyone (the share rules say only the owner shares) | Low (confidentiality; the owner had chosen to trust the editor with the content) | Fixed |
| P3-13 | Reminders and digest (B2) | Reminders and the overdue digest fall back to the OWNER of an unassigned task; for a task about a record, the owner may have lost read access (role removed), yet the reminder title and the digest lines still named it ("Reminder: <subject>") | Low (a subject line the person could read before) | Fixed |
| P3-14 | Client rendering (B1, B2) | The approvals page put stored comment bodies and request details into `dangerouslySetInnerHTML` without sanitising them again (the server sanitises on write; a row written another way, such as a crafted backup restored by an administrator, would run) | Info (defence in depth) | Fixed |
| P3-15 | Database connections, TLS (A) | With SSL on, the MySQL connector checks the certificate chain but not that the certificate names the host (mysql2 checks the name only with `verifyIdentity`, which is not set); PostgreSQL checks both | Low (needs a man in the middle with a certificate from a CA the server trusts) | **Open** (turning it on changes on-premises behaviour for certificates that do not name the host typed; no TLS MariaDB in the sandbox to test it) |
| P3-16 | Pack upgrades (B3) | The upgrade plan lists a pack role whose privileges the new version changes as "changed", without saying that its access WIDENS (a looser row rule, a column no longer hidden); a role the customer changed here is kept by default (good), an untouched one takes the new rule | Low (built-in packs only, upgrades by administrators who read the plan) | **Open** (found by reading; no newer pack version exists to test against) |
| P3-17 | Chat export (B1) | The export link works more than once within its hour for the exporting administrator | Info | Accepted (each download audited; the members are told once at creation) |
| P3-18 | Licence service (B6) | Whoever holds a licence's install key can check in with invented install ids; after 7 days of alternating, the older (legitimate) install is answered `duplicate` and becomes read-only | Low | Accepted (the key is a secret in the instance's environment; the operator sees both installs and releases one: `licence-service install release`) |
| P3-19 | Deep links (B7) | Opening `#u-notes?new=1&table=..&row=..` creates an empty note about that record at once (a link someone sends makes a note in the reader's name) | Info | Accepted (only about a record the reader may read, else 422; the exit check and the timeline use the link; no content is written) |

## Details

### P3-1 Balance refusals as an oracle (Medium, fixed)

*Reproduce*: a "clerk" role creates rows of the movements table (`P3Moves`) and reads items and locations, with no
access to the balance table (`P3Stock`). The clerk records an issue of 100 against a key holding 37: the answer was
`Stock of Hex bolt at Main store would go below zero: available 37, requested 100.` with `balance.available: 37` in the
body. A "picker" who may not read the items saw the item's name ("Project Falcon prototype") in the same message: the
engine read the lookup's display column with plain SQL, without row or column security. Repeating with any amount gives
the exact stock of every key in one request each.

*Fix*: `server/core/balances/engine.ts` takes a `BalanceViewer` (built in `server/core/data.ts` `balanceViewer` from the
writer's context); the quantity (and a minimum column) is stated only to someone who may read that column of EVERY row
of the balance table (table access, a read rule that is not narrowed per row, column not hidden), and a key is shown by
its lookup display name only on the same condition for the lookup table (else by its id). Others get
`... would go below its minimum: there is not enough for this change (you may not see the quantity available).` without
`available` in the body; a pack's custom `message` is not used for them. Writes by the platform itself (no person) are
unchanged. Test: S-I "FINDING P3-1". Residual: someone who may record movements can still bisect the quantity by trying
amounts (each accepted try is a real, audited movement that they then have to reverse).

### P3-2 The seat pass outside the router (Low, fixed)

*Reproduce*: Mo holds the Maker role and an Operator pass. `POST /auth/login` answered `privileges.isMaker: true` (the
client showed Dev mode until its next `GET /auth/session`); on `/api/v1/live` Mo could subscribe to
`presence:studio:<app>` (and so take or contest the Studio's soft edit lock on any app), and the socket's table check
used the maker shortcut. Max, a Full user in the Studio, kept the Studio subscription after an administrator gave him an
Operator pass: the hub keeps contexts for a while and nothing told it the pass changed.

*Fix*: one helper `applyPass` (`server/core/licence/seats.ts`) used by the session resolver, the live hub's context
(`server/core/live/hub.ts` `ctxFor`) and the sign-in answer (`server/core/auth.ts` `finishSignIn`); `assignPasses`
calls `security.invalidate()`, so the hub drops its contexts and re-checks every subscription. Test: S-I "FINDING P3-2",
S-U "FINDING P3-2 / P3-3". Not changed: contexts built for the reader of a chat card or of chat itself
(`chat/cards.ts`, `chat/service.ts`) still come without the pass; they only use run-app and data rights there, which the
pass does not change (an Operator keeps "the data the roles allow").

### P3-3 Maker routes without the pass flag (Low, fixed)

*Reproduce*: every route was enumerated as Ola, an environment administrator with an Operator pass. All `auth: 'maker'`
and design routes were refused, but `POST /flows/:flowId/webhooks`, `PATCH /webhooks/:id`, `POST /webhooks/:id/rotate`,
`DELETE /webhooks/:id` (and the GET list) and `PUT` / `DELETE /connections/:id/custom-actions/:action`,
`POST /connections/:id/custom-actions/openapi` are `auth: 'user'` routes whose handlers allow administrators: they
answered 404 "no such flow" / "connection not found", i.e. they were reachable, and with real ids they worked. This is
building (a flow's trigger, a connector's actions), which the Operator pass excludes "also for administrators".

*Fix*: those routes carry `pass: 'full'` (`server/core/actions/webhooks.ts`, `server/core/actions/routes.ts`). A Full user
with a connection's "manage" grant keeps using custom actions. Test: S-I "FINDING P3-3" requests EVERY route whose
options say maker, design (non-GET) or Full pass as that administrator and expects 403 for each (more than 100 routes; a
route added later with one of those options is covered automatically, a route that does maker work under
`auth: 'user'` is not: review it when it is added). Not flagged on purpose: `PUT /flows/settings` (pausing all flows),
`POST /tables/:id/assign-owner`, connections, users, backups: administration, not building.

### P3-4 The outbound deny list by name only (Low, fixed)

*Reproduce*: with `APPBUILDER_OUTBOUND_DENY=apps.example.com` (the hosted profile adds the install's own public host),
an HTTP connection, database connection, SMTP relay or OAuth endpoint at `203.0.113.7` (the address of
`apps.example.com`), at `[::ffff:203.0.113.7]` or at `alias.example.net` (a name the administrator points at it) was
allowed: the list was compared with the name typed. The threat model (row 3) says the install's own public address is
refused (the hairpin through Caddy), and the hosting guide (`docs/admin/hosting.md`) tells operators to add the server's
public IP addresses to the list: before this fix that refused the literal address only, not a name resolving to it.

*Fix*: `server/core/net-policy.ts` `deniedAddresses` / `deniedAddressProblem`: IP entries as written and the addresses
the listed names resolve to (cached a minute) are compared with every address a host resolves to, in one comparable
form (IPv4 inside IPv6 as IPv4); used by `assertOutboundHost` and by the HTTP connector's `resolveAllowed`
(`server/core/actions/outbound.ts`, which then connects to that checked address). Test: S-U "FINDING P3-4". Residual:
`*.domain` entries cannot be resolved and stay name-only; a listed name behind a SHARED address (a CDN or a shared load
balancer in front of the install) would refuse every other host on that address, so the fleet should keep the public
address the server's own; a sibling install reached by its public address is the
public route anyway (as for any other customer on the internet).

### P3-5 The error-boundary test hook in production (Info, fixed)

`window.__abForceCrash(scope)` makes a part of the viewer's own page fail; it was defined in the production build. It
only ever broke the caller's own page, but production code should not carry a switch that changes behaviour from the
console or from a script someone is talked into pasting. *Fix*: `src/components/testHooks.ts` `testHooksEnabled`, used by `src/components/ErrorBoundary.tsx`:
the hook does nothing unless the build is a development build or `localStorage['ab:test-hooks']` is `"1"` (the exit check
`scripts/exit-check/p3-misc.mjs` sets it before the page loads). Test: S-C "FINDING P3-5". The other hooks
(`window.__ab` store, `__abChat`, `__abOffline`, `__abLayer`, `__abRegistry`) read or change the state of the caller's own page (the store's actions, dropping their own chat socket);
they give a script in the page nothing it could not get from the page itself, and many exit checks rely on them: left as
they are (residual).

### P3-6 DNS rebinding of database connection hosts (Medium for hosted installs, fixed in the second pass)

`server/core/connections.ts` checks an external database connection's host at every use (the "re-check added this
week"), which closes the case of a name that simply resolves to 127.0.0.1. It did not close rebinding: the check calls
`dns.lookup`, then node-postgres (or mysql2) called it again in `net.connect`, and the pool opened further connections
later without any check. A DNS server under the administrator's control answering with a time to live of 0 (public
address, then 127.0.0.1) made the driver connect to the server's own PostgreSQL. On a hosted install that is the cluster
that holds every install's database; the role and password of another install are still needed (REVOKE, per-role
passwords), and whether anything on 127.0.0.1 accepts without a password was not checked on a real server. The same
applied to "test connection" and table introspection.

*Fix* (second pass): the drivers never resolve the name themselves.

- `server/core/net-policy.ts` `guardedLookup(host, what, { first })`: a `dns.lookup`-compatible function. The first call
  for the host answers `first` (the addresses `assertOutboundHost` returned to the connection manager a moment before);
  every later call resolves again and runs `assertOutboundHost` on every address, then answers the checked address. A
  refusal or a name that does not resolve is the connection's error (ENOTFOUND or the policy's 422); there is no fallback
  to the system resolver. `pinnedSocket(lookup)`: a `net.Socket` whose `connect(port, host)` passes `lookup` to Node, so
  the connection goes to the address the lookup checked while the socket keeps the NAME (a local socket path is left as
  it is).
- **pg 8.23.1**: `Client` / `Pool` take a `stream` factory (`config.stream`, called once per physical connection, then
  `stream.connect(port, host)`); `poolConfig(..., { lookup })` in `server/connectors/postgres/db.ts` sets
  `stream: () => pinnedSocket(lookup)`, used by the connector's pool and by `withClient` ("test connection"). `host` stays
  the name, so pg sets the TLS `servername` from it and certificates are verified against the name.
- **mysql2 3.24.6**: the pool and `createConnection` take a `stream` factory too (`config.stream(opts)`, which must return
  a connecting socket); `poolOptions(..., { lookup })` in `server/connectors/mysql/db.ts` returns `pinnedSocket(lookup)`
  already connecting, with no-delay and keep-alive as mysql2 sets them on its own socket. mysql2 takes the TLS server name
  from `host` (the name); see P3-15 for what it verifies.
- `connections.ts`: the checked addresses (sorted) are part of the connector fingerprint, so a host that starts
  resolving elsewhere gets a new pool (and the old one is closed); the manager hands the connector `env.dbLookup`. The
  default connection (`conn_default`, the install's own database) is not checked and gets no lookup. On-premises nothing
  changes for allowed loopback and private addresses.

Tests (failed with the fix switched off, both connectors): S-U "FINDING P3-6" (the lookup on its own; then pg and mysql2
pools whose resolver, the injected one AND the process's `dns.lookup`, answers 192.0.2.10 first and 127.0.0.1 after: the
first connection goes to 192.0.2.10, the second is refused by the policy, a canary listener on 127.0.0.1 counts no
connection; with the `stream` option removed the canary was reached and the tests failed); S-I "FINDING P3-6" (POST
`/connections` for postgres and mysql, "test" and the source-table list through the pool, with the policy's lookups
answered with a public address and the drivers' own lookups with 127.0.0.1: no canary connection; then the name turns to
127.0.0.1 for the policy too and the next test is refused before any driver runs; with the manager's `dbLookup` switched
off the canary received 2 connections). The isolation suite's "Outbound from A" (`server/core/hosting`) still passes.
Residual: a real DNS server on the fleet was not used; a database reached through an allowed address can still forward
the connection elsewhere; the first connection of a pool uses addresses checked when the connector was taken, at most a
moment before.

### P3-11 Moderation could remove the export announcement (Low, fixed)

*Reproduce*: Ada (install administrator) exports the direct conversation of Kit and Cleo with a typed reason; the
members get the system line "An administrator exported this conversation on <date>". Ada then calls
`POST /chat/admin/messages/<that line>/moderate`: 200, the line became "message deleted". The export and the moderation
were both audited, but the people concerned no longer saw that their conversation had been exported. *Fix*:
`removeMessage` (`server/core/chat/service.ts`) refuses a system message for administrators with 422 (people never could
delete one); reports cannot be made on system lines, so "delete" on a report is not affected. Test: S-I "chat: the
administrator export ... (FINDING P3-11)", which also covers a wrong or missing token (404), another administrator with
the right token (404), a second download within the hour (200, two audit entries: P3-17), an expired link (410) and that
people's messages can still be moderated.

### P3-12 An edit share could pass a note on by assigning it (Low, fixed)

*Reproduce*: Cleo shares her note "P3 secret plan" with Kit for editing. Kit sets `AssignedTo` to Pip through
`PATCH /data/sys_activities/rows/:id`: 200, and Pip could open the note (`GET /notes/:id` 200), because the Activities
read rule includes "assigned to me". The update rule allowed it (`sharedEdit` in both halves of the rule), and the share
table's own rule (only the owner writes shares) does not see assignments. *Fix*: `collab.ts` (the Activities write hook):
changing `AssignedTo` or `AssignedTeam` needs the writer to be the owner, the creator, the current assignee or a member of
the assigned team (administrators unchanged); otherwise 403 with a plain reason, and a row the writer cannot read is left
to the usual 404 (no existence answer). The team list comes from the organisation directory (`teamsOf`, `services.ts`).
An assignee handing a task on is unchanged (the core data model's rule). Test: S-I "tasks and notes: ... (FINDING
P3-12)", which also shows that a read share cannot edit, re-share or upgrade its own share, that nobody can create a
share on someone else's note, that `owner` sent by an editor is ignored, that an editor cannot delete, and that the owner
still assigns.

### P3-13 Reminders and the digest named tasks the owner may no longer read (Low, fixed)

*Reproduce*: Tia reads the project "Falcon" through a role and creates an unassigned task about it, due two days ago with
a reminder. An administrator removes the role: Tia can no longer read the project, so the task (about a record, not
assigned to her) is no longer hers to read. `tasks.reminders` sent "Reminder: P3 Falcon launch checklist" and
`tasks.digest` listed it, because both fall back to the owner without a read check. *Fix*: `server/core/tasks/service.ts`
takes `canRead` (wired to `collab.readersOf` in `services.ts`); a task about a record that falls back to its owner is
checked with the owner's own security context and left out (the reminder is still stamped as spent). Assignees and
personal tasks are not checked (they are readable by rule). Test: S-I "tasks: reminders and the overdue digest ...
(FINDING P3-13)" with an injected clock, with a personal task as the positive control.

### P3-14 Stored HTML on the approvals page (Info, fixed)

`src/approvals/ApprovalsPage.tsx` rendered comment bodies and request details with `dangerouslySetInnerHTML` straight
from the API. The server sanitises both when they are written, and no write path around it was found, but every other
place (chat, the record timeline) sanitises again in the browser. *Fix*: `sanitizeRichText` around the three values. Test:
S-U "guard (P3-14)" lists every `dangerouslySetInnerHTML` in `src/**/*.tsx` and fails for one fed by anything but a
sanitiser call or a value checked by reading (`html` in the timeline, the server-generated QR code SVG).

### P3-15 MySQL TLS without a host name check (Low, open)

mysql2 3.24.6 verifies the server certificate against `servername` only when `ssl.verifyIdentity` is true;
`poolOptions` sets `rejectUnauthorized: true` without it, so any certificate from a trusted CA is accepted for any host.
Not changed: a customer connecting by a name their certificate does not carry (or by IP address, where mysql2 sets no
server name) would be refused after an upgrade, and there is no TLS MariaDB in the sandbox to prove the change. Proposed:
`verifyIdentity: true` when the host is a name, with a release note.

### P3-16 Pack upgrades and widened role access (Low, open)

`upgradeContext` (`server/core/templates/service.ts`) compares each pack role with the hash of what was delivered: a role
changed here is listed and kept by default (read, and covered by the packs suite), an untouched role takes the new
version's privileges. The plan item says "changed", not that the change widens access (a row rule removed or loosened, a
column no longer hidden, a scope from own to all). Not attacked by test: no built-in pack has a newer version whose role
widens access, and the catalogue accepts only shipped, digest-checked packages. Proposed: compare old and new privileges
per pack table and add a plan warning "gives <role> more access: ..." that the administrator must confirm.

### Accepted

- **P3-17 the export link within its hour**: see P3-11; each use is audited with the export id.
- **P3-18 the duplicate-install rule**: needs the install key; the operator's `install release` undoes it.
- **P3-19 `#u-notes?new=1`**: the note is about a record the person may read (others get 422 and no note); it is empty
  and the person's own.
- **P3-7 `requester` from user-edited data**: the flow designer and pack authors should take the requester from
  `Trigger.Record.owner` or `Trigger.User`, not from a free person field. The step still never takes the triggering person
  off the excluded list.
- **P3-8 formSubmitted starts**: the write must really have been committed by the claimant, who must be allowed to run
  the app, and the Form's table must be the written table (checked); the run's data is the committed row, never the body.
  A save without changes still counts as a save.
- **P3-9 cards from others**: a card is a reference; its resolution and its buttons are the reader's. A forged approval card
  in a group chat is at worst a nudge to answer a real request the reader may answer anyway.
- **P3-10 truncated rich text**: see the table.

## Coverage (both passes)

"Tested" means a test in the files named above (or an existing suite named here) that runs against the code; "read" means
the code was read and nothing was run for that point; "not covered" means neither. Second-pass areas are B1 to B7.

| Area | Attacked by test | Only read | Not covered |
| --- | --- | --- | --- |
| Chat (1, B1) | First pass: none of its own (the existing leak suite `chat-security.integration.test.ts`). Second pass, S-I: a member cannot edit or delete another's message; a non-member gets 404 on edit, delete, reactions, report, replies and card resolution of a private message; every `/chat/admin/*` route (enumerated from the router, so later ones are included) refuses a member and a non-member with 403; a draft file cannot be named in another conversation or by another person, nor uploaded or discarded by a non-member, and is used once; search with `channel=` and the mention picker answer a private conversation exactly like a missing one; typing is refused to a non-member (HTTP and the `chat:typing:` topic); removal: reads racing the removal answer 200 or 404 only, the socket gets `unsubscribed`, no later push or typing event, history / `around` / `changes` / members / replies 404, search finds nothing, no notification for later messages; the export: wrong or missing token, another administrator, expiry (410), a second download (audited), a direct conversation, the announcement visible to members and not removable (P3-11); retention of one kind leaves other kinds and other collaboration rows alone | Cards per reader, the Approvals conversation, the digest relevance check after removal (`digestRelevance`), message rendering (`MessageItem` sanitises again; files are served with `Content-Security-Policy: sandbox`; images only from the attachment route), links (`http(s)` and `#` only), the pop-out channel; mention refusals name the person (by design: a mention of someone outside a private conversation says who, the picker only lists members) | Response timing as an oracle (not measured); a card refresh after removal; chat topics after switching the chat environment or losing access to it (the hub re-checks on access changes: read); moderation and send rate limits beyond the limits suite |
| Notes and tasks (2, B2) | First pass: the sanitisers (S-U guards). Second pass, S-I: a read share cannot edit, re-share or upgrade its own share; nobody can create a share on someone else's note; an edit share edits, but cannot re-share, delete, change the owner (ignored) or assign (P3-12); the owner still assigns; a team share ends when the person leaves the team (also in "Shared with me"); a note about a record the writer cannot read is refused without its name; reminders and the digest leave out a task the owner can no longer read (P3-13) | Recurring tasks (the next occurrence copies owner, creator, assignee, team and regarding, never shares: it fails closed for share holders), note bodies outside the editor (notification text and digest lines use plain text; list snippets are plain text; notes are not on the timeline), the autosave conflict path | The search highlight in a real browser; notes and tasks through flows' data steps |
| Flows and approvals (3) | First pass: none (by request) | `requester`, `causedBy`, `owner` of create, formSubmitted, notify roles (P3-7, P3-8) | Everything else in flows and approvals |
| Templates and packs (4, B3) | First pass: none of its own (the pack suites exist). Second pass: none | Catalogue integrity (digest manifest, no route takes a package), install and uninstall (only components in the install register; tables the pack created are removed only when empty or by an administrator's explicit choice; mapped and shared tables untouched), reference and SAMPLE rows only into tables the pack created, pack flows arrive off (an administrator switches them on), role upgrade (a locally changed role kept by default; widened access not singled out: P3-16) | Uninstall attacked with rows people added; the install register after an environment copy (whether a copy can uninstall components its copier may not manage); `owner` / `requester` formulas of the built-in packs one by one |
| Balances (5, B4) | First pass: P3-1. Second pass, S-I, the invariant "balance = sum of live movements, never below the floor" checked after each step: a refused issue (neither movement nor balance stays), non-numeric, NaN, 1e400, Infinity, object and list quantities (422), CSV append with one bad line (all refused) and a good one, a key change, a refused move between keys, large (123456789.123457) and tiny (0.000001) decimals, a refused delete, delete then a refused restore from the recycle bin, the offline outbox's Idempotency-Key (one movement for two sends), concurrent inserts and deletes, CSV replace | One unit of work per DataService write (a later failure rolls the balance back: no route was found that fails after the balance step, so it was not forced) | Bulk import through a solution; a flow's data step; a solution upgrade changing the declaration while movements exist; precision above about 9e9 units (fixed point in a double); lock contention as denial of service |
| Query v2 and lookup sort (6, B5) | First pass: the removed v1 route. Second pass, S-I: rows whose target the viewer may not read sort exactly with blank lookups (ascending and descending, ties by the listed row's natural order), page by page equal to one page, renaming hidden targets between pages moves nothing, a blank filter with a count, a `via` filter naming a hidden target finds nothing; four hostile `via` shapes (quotes, SQL, a system table, an id) answer 4xx and the table is intact; four lookup sort keys are refused (limit 3) | The `sortJoins` SQL (one uncorrelated join per key, the target's row filter inside), the cursor content | Timing of plans with hidden targets; a visible target changing between pages (the dev document says the order is "as it is now") |
| Hosting, licence service and CLIs (7, B6) | First pass: P3-2, P3-3, P3-4. Second pass: P3-6 (S-U, S-I); the licence service's handler over a recording fake database (S-U): 10 checks per key per minute from any address (the 11th 429), 30 per address (the 31st 429; behind the proxy the last `X-Forwarded-For` entry counts, a forged first entry does not help), an unknown and a revoked key run the same statements and get the same answer apart from the echoed ids, the check-in row holds time, licence, install id, version, seat counts and outcome only, extra members of the counts are dropped, hostile ids, versions and counts are refused (400) before any statement | `migrate`, `admin invite`, `read-only on/off/status` need the instance's environment (its database login; the server's secret for tokens): whoever can run them already has the install; each is audited (`install.cli_migrate`, `install.cli_admin_invite` plus `user.create`, `install.read_only_on` / `_off` with the OS user and host); the invitation is a one-time token for 7 days, a new one voids the earlier, it grants an install administrator with the Administrator role; the service's SQL is parameterised; the duplicate-install rule (P3-18) | The CLIs run against a hosted install; the read-only gate beyond its suite; "check now" as an amplifier; the stored licence document after a backup restore; the real fleet (the isolation suite `server/core/hosting/isolation.integration.test.ts`, the same suite as `h-isolation.mjs`, ran and passed on Windows with TCP listeners only) |
| Client hardening and parameters (8, B7) | First pass: P3-5. Second pass, S-U: kiosk cycling parameters (only server range presets, seconds and pages clamped, a malformed or second token ignored), start addresses (a plain app id; `screen` matched by name or id among the app's own screens, an unknown one reported, values kept as text), the `dangerouslySetInnerHTML` guard (P3-14) | The kiosk query route compiles the dashboard's own tiles and refuses plans in the body; `Param()` values are data to formulas that query as the viewer; `#u-notes?new=1` (P3-19) and `#u-notes?n=` (404 for an unreadable note) | Any of it in a real browser beyond the exit checks |

## Residual risks

Carried into the [security model](../admin/security-model.md#explicit-limitations):

- Balances: a person who may record movements can bisect a quantity they may not read (each try is a real movement).
- A refusal to someone with a per-row read rule on the balance table hides the quantity even for rows they can read
  (the check is "every row", because the refusal is computed without row security).
- `requester` formulas over user-edited fields (P3-7); formSubmitted starts per save (P3-8); cards posted by others (P3-9).
- `*.domain` deny entries by name only; a database server reached through an allowed address can forward elsewhere
  (P3-6 is fixed for what the policy can see).
- MySQL TLS does not check the host name (P3-15, open); pack upgrades do not single out widened role access (P3-16, open).
- The export link works more than once within its hour (P3-17); the duplicate-install rule in the hands of a key holder
  (P3-18); `#u-notes?new=1` makes an empty note (P3-19).
- An assignee can hand a task to anyone, who then reads it even without access to its record (the core data model's
  rule, unchanged); notifications created before access was lost stay in the feed.
- The read-only test hooks stay in the production build (P3-5).
- Chat and card contexts are built without the pass (no effect today; a future maker-only card kind would need it).

## Not reviewed / needs an outside reviewer

- **A real Linux server** with per-install OS users, systemd sandboxing, disk quotas, Caddy and the fleet tool: nothing
  in this review ran there; the fleet threat model's "confirmed" rows were read, not re-tested. The fleet tool
  (`scripts/fleet/**`), the installer and CI are another agent's work and were not read.
- **Real devices**: no real phone, no Safari, no Firefox; the client findings are pure-logic tests in Node.
- **The real Meta API**: WhatsApp is still only tested against the fake Graph API.
- **Cryptography**: the licence scheme (Ed25519 answers, nonce, key ids and rotation, install keys and their hashing, clock
  handling), the chat export tokens, the signed unsubscribe links and the template digest manifest were reviewed by
  developers, not by a cryptographer.
- **Load and denial of service at scale**: no load test (another agent is doing one), no slow-loris test against Caddy, no
  measurement of balance lock contention, chat fan-out or note sanitising under parallel load.
- **Third-party libraries** (pg, mysql2, ws, pdfkit, PizZip, docxtemplater): used as they are, not fuzzed.
- The items in the "Not covered" column of the coverage table above.
