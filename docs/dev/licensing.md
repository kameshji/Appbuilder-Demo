# Licensing in the code (H-G, H-H)

Administrator view: [docs/admin/licensing.md](../admin/licensing.md). Design: [hosting spec section 7](../plan/hosting-spec.md).

## Files

| File | What |
| --- | --- |
| `server/core/licence/answer.ts` | the one wire format (request, signed answer, payload), Ed25519 sign and verify (Node's `crypto`), key generation, id formats. Shared by service and client |
| `server/core/licence/keys.ts` | the trusted licence public keys: `licence-keys.json` next to it (shipped in the release), or `APPBUILDER_LICENCE_PUBLIC_KEY[_FILE]` (replaces them; tests, evaluations) |
| `server/core/licence/client.ts` | settings, the injectable clock (`APPBUILDER_LICENCE_TEST_CLOCK_FILE`), the stored state, the pure `evaluate`, `acceptAnswer`, the client (check, tick, timers) |
| `server/core/licence/seats.ts` | passes in `ab.user_settings` (key `licence.pass`), counts, `withPasses` (session resolver), `passRefusal` (router), bulk assignment, over-seat tracking |
| `server/core/licence/index.ts` | `startLicence` / `stopLicence` (createApp), the `ab.licence` store, notifications to install administrators, the four routes |
| `server/licence-service/{main,cli,service,store}.ts` | the licence service: entry, operator CLI, the HTTP endpoint and its decisions, its database |
| `src/portal/AdminLicence.tsx`, `src/portal/UserPasses.tsx`, `src/portal/licenceApi.ts` | Admin console > Licences; the Pass column and bulk action in Admin console > Users |
| `scripts/exit-check/h-licence.mjs` | exit check 6 with real processes |

Registration lines elsewhere: `server/core/app.ts` (resolver wrapped by `withPasses`, `licenceRoutes`, `startLicence`
after boot, `stopLicence` on close), `server/core/router.ts` (`passRefusal` after the auth level), `server/core/contracts.ts`
(`RouteOptions.pass`, `UserContext.pass`), `server/main.ts` (`licence-service` command), `server/core/hosting/read-only.ts`
(`POST /install/licence/check` allowed while read-only; `setLicence` takes a reason), `server/core/hosting/hosting.test.ts`
(the two files that open connections), `src/portal/Admin.tsx` (mounts `AdminLicence`).

## The answer

Request (`POST /v1/licence/check`, `Authorization: Bearer abl_<43 base64url>`):
`{ v: 1, licenceId: "lic_...", installId: "ins_...", version, nonce, seats: { full, operator, external } }`.

Answer: `{ alg: "ed25519", keyId, payload: base64(JSON bytes), signature: base64 }`. The signature covers the exact
payload bytes; the client parses only bytes it verified. Payload:

```
{ v: 1, licenceId, installId, status: active|payment|suspended|cancelled|duplicate|refused, plan, kind: subscription|lifetime,
  seats: { full, operator, external } | null, paidUntil, maintenanceUntil, noticeDays, readOnlyFrom, message,
  issuedAt, validUntil (= issuedAt + 72 h), serverTime, nonce }
```

Unknown, revoked, missing and other-licence keys all get the same signed `refused` payload (ids and nonce echoed,
`seats: null`). A malformed request is an unsigned 400, rate limiting an unsigned 429. The client accepts an answer only
if the signature verifies with a trusted key id, `nonce` is the one it just sent, `licenceId` and `installId` are its own,
`|serverTime - issuedAt| <= 1 min`, `0 < validUntil - issuedAt <= 72 h + 1 min`, and the status is not `refused`.

Key ids are those of the release keys (`update/release.ts keyIdOf`). The licence key pair is separate from the release key
(`licence-service keygen`); its private key never enters the repository (keygen refuses a folder inside it, except the
git-ignored `.sandbox` used by tests; tests generate keys at run time).

## What the client stores (`ab.licence`, row 1, `document`)

`{ v, installId, firstCheckAt, highWater, last: { answer (as received, signed), receivedAt }, lastCheck: { at, ok, error },
failingSince, overSince: { <pass>: ms }, notices: { <key>: ms } }`. Times are the install's local clock in ms.

- The last answer is verified again every time it is used; a changed byte makes it count as no answer.
- Its local validity is `receivedAt + (validUntil - serverTime)` (at most 72 h): a server clock that is wrong but steady
  neither shortens nor lengthens the grace.
- **Clock rollback**: `highWater` is the latest local time seen, raised at every tick (1 minute; written at most once a
  minute) and check. `now < highWater - 5 min` is evaluated as read-only (reason licence) until a fresh valid answer,
  which is the only thing that sets `highWater` back to the current time. A restart keeps it (stored).
- No valid answer ever: the 72 hours run from `firstCheckAt`.

## Decisions (pure `evaluate`)

Order: not configured -> unlicensed (no gate, nothing sent); clock behind high-water -> read-only licence; no valid
answer -> warning until `firstCheckAt + 72 h`, then read-only licence; past local validity -> read-only licence;
`duplicate` -> read-only licence; `payment` / `suspended` / `cancelled` -> warning until `readOnlyFrom` (mapped to local
time), then read-only with reason `payment` / `suspended`; failing checks -> warning naming the local validity end.
The result goes to `readOnlyGateFor(services).setLicence({ reason, message, since })`; routes and jobs then behave as for
every read-only reason ([hosting.md](hosting.md)). Error code: `licence_read_only` for reason licence, `install_read_only`
for payment and suspended.

## Passes on the server

`withPasses` wraps the session resolver: a person whose pass is not `full` gets `privileges.isMaker = false` (also in
`session()`, which `GET /auth/session` returns, so the client hides Dev mode) and `ctx.user.pass`. Every `auth: 'maker'`
route and every handler that checks `isMaker` therefore refuses. `passRefusal` in the router also refuses DESIGN_ROUTES
(non-GET), `auth: 'maker'` routes and routes flagged `pass: 'full'` to a non-full pass, administrators included (403
`denied`, "needs a Full user pass"). Passes are cached 5 seconds per process; an assignment clears the cache entries of
the people it changed. A new maker feature with `auth: 'user'` that checks `isMaker` itself is covered; one that does
neither must set `pass: 'full'`.

## Tests

`server/core/licence/client.test.ts` (no database: the full 72-hour timeline with an injected clock and an in-process fake
service, clock rollback before and after a restart, suspension and payment with notice, duplicate, forged / foreign-key /
replayed / other-organisation / refused answers, a stored answer edited in the database, unconfigured),
`server/core/licence/licence.integration.test.ts` (a real install and the real service in process: grace, export and
sign-in while read-only, suspension, Operator refused from the Studio routes, over-seat warnings and the 14-day block),
`server/licence-service/service.integration.test.ts` (CLI and audit, same answer for unknown and revoked keys, rate
limits, duplicates, keygen), `node scripts/exit-check/h-licence.mjs` (real processes, real clock file).
