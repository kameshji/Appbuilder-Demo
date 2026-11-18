# Authentication and identity (design)

P0 package I. Admin view: [docs/admin/sign-in-and-identity.md](../admin/sign-in-and-identity.md); threat model:
[docs/admin/security-model.md](../admin/security-model.md); decision D20 in [decisions.md](../decisions.md).

## Files

| File | What |
| --- | --- |
| `server/core/auth.ts` | Password sign-in (`POST /auth/login`), `createSession`, `sessionResolver` (cookie or bearer), `finishSignIn` (the end of every successful sign-in), `sessionPayload`, throttles |
| `server/core/password.ts` | scrypt hashing, `checkPasswordPolicy` (length from the policy, common-password list `identity/common-passwords.txt`) |
| `server/core/identity/index.ts` | `identity(services)`: one instance per Services: policy store, mail service, counters, tokens, TOTP and recovery codes, MFA requirement, remembered devices, sign-in log, `requireRecentAuth` |
| `server/core/identity/routes.ts` | Every identity route (list at the top of the file) |
| `server/core/identity/api-keys.ts` | Service accounts' keys, `resolveApiKey`, `bearerAllowed` |
| `server/core/identity/policy.ts` | `SecurityPolicy`, validation (`mergePolicy`), storage in `ab.settings` `identity.policy` |
| `server/core/identity/passwords.ts` | Password history and maximum age |
| `server/core/identity/totp.ts` | RFC 4226 HOTP, RFC 6238 TOTP, Base32, otpauth URI (Node `crypto` only) |
| `server/core/identity/qr.ts` | QR SVG (encoding by `qrcode-generator`, MIT; the SVG is one path, CSP-safe) |
| `server/core/identity/smtp.ts` | Minimal SMTP client: STARTTLS / TLS / plain, AUTH PLAIN and LOGIN, MIME |
| `server/core/identity/mail.ts`, `templates.ts` | Relay settings, `mail.send` job type, delivery log, system templates |
| `server/core/identity/ddl.ts` | Tables (schema version 7) |
| `server/core/identity/fake-smtp.ts` | Test helper: a fake SMTP server with an inbox (tests and `scripts/docs-shots/identity.mjs`) |
| `src/portal/identityApi.ts`, `Identity.tsx`, `AdminIdentity.tsx` | Client calls, shared UI (re-auth dialog, enrolment, sessions), admin pages; `Auth.tsx` (sign-in screens), `Settings.tsx`, `Users.tsx` |

## Sign-in sequence

```
POST /auth/login {email,password}
  throttles (per email+address, per email backoff; values from the lockout policy)
  verifyPassword (unknown / disabled / service account / no password: verifyDummy, same time, same 401)
  password older than maxAgeDays -> must_change_password
  user has TOTP or email codes?
    remembered device cookie valid -> finishSignIn(method remembered_device, mfa)
    else: auth_tokens 'mfa_pending' (5 min), cookie ab_mfa, 401 { error: { code: 'mfa_required' }, mfa: { methods, rememberDays } }
  policy requires MFA and the grace period is over -> session restricted 'mfa_enrol'
  finishSignIn -> new session, audit auth.login, sign-in log, new-device email, Session payload
POST /auth/login/verify {code, method: totp|recovery_code|email_code, remember}
  ab_mfa -> pending token; account second-step lock (policy); check the code; 5 wrong -> pending token consumed
  consume pending token (atomic) -> optional remembered device -> finishSignIn(mfa)
```

The client: `platform.auth.login` throws `PlatformError('mfa_required')` (with `mfa`); `LoginScreen` shows the second step
and finishes with `platform.auth.completeSignIn(session)` (also used by invitation accept and forced enrolment).

## Sessions

`ab.sessions` row: SHA-256 of the cookie token (`id_hash`), `public_id` (random, what lists show and revoke by),
`created_on`, `last_seen`, `expires_on` (sliding: min(now + idle, absolute)), `absolute_expires_on`, `auth_on` (last
password or code proof), `mfa`, `restricted`, `ip`, `user_agent`. The resolver ends a session when it is past
`expires_on`, past `absolute_expires_on`, or `last_seen` is older than the idle timeout; it touches the row at most every
min(10 minutes, idle/4). `noteRequestSession(req, ...)` keeps the session of a request for `requireRecentAuth`,
rotation and the "current" marker.

Ending sessions goes through `MetaStore.sessions.remove/removeForUser` so the realtime hub closes sockets
(`live/session-events.ts`). **Rotation** (MFA on/off) updates `id_hash` in place and emits `{ kind: 'rotated' }`: the
hub moves the sockets to the new id instead of closing them (closing raced with the response that carries the new
cookie and could sign the tab out). Password change: `removeForUser` + a new session for this browser.

A restricted session (`mfa_enrol`) gets `mfaEnrolmentRequired` on its `UserDef`; the router answers 403
`mfa_enrolment_required` unless the route has `allowPendingMfaEnrolment`; the hub refuses its socket.

## Crypto choices

| What | How |
| --- | --- |
| Passwords | scrypt N=32768 r=8 p=1, 16-byte salt, 64-byte key (unchanged) |
| Session, pending-MFA, reset, invitation, email-change tokens | 32 random bytes (base64url), SHA-256 at rest, single use by `UPDATE ... WHERE used_on IS NULL RETURNING` |
| Administrator reset codes | 12 characters of a 31-letter unambiguous alphabet (~59 bits), 24 h, SHA-256, rate limited per address and email |
| Email codes | 6 digits, 10 minutes, hash over `userId.code`, single use, at most 5 wrong per pending sign-in |
| TOTP | HMAC-SHA1, 6 digits, 30 s, window ±1 step, 160-bit secret sealed with the secret box (AES-256-GCM); replay: `totp_last_step` updated only if the new step is greater, in one statement |
| Recovery codes | 10 x 16 characters (~79 bits), SHA-256 in `ab.user_mfa.recovery` (jsonb), consumed under `SELECT ... FOR UPDATE` |
| Remembered device | cookie `ab_td` = secret box seal of `{u, d, x}` (authenticated encryption: tampering fails), plus a revocable `ab.trusted_devices` row |
| Known device (new-device email) | cookie `ab_dev`, random 18 bytes; SHA-256 stored in `ab.signin_log.device_hash` |
| API keys | `abk_<8 alnum>_<32 bytes base64url>`, SHA-256 of the whole key, looked up by prefix, compared in constant time |
| SMTP password, queued mail | secret box |

Comparisons of codes and hashes use `timingSafeEqual`. TOTP checks every step of the window (no early exit).

## Enumeration

`POST /auth/password/forgot` validates and rate-limits on the input only, answers, and does the account lookup, token and
email in `res.on('finish')`. Its body depends only on whether email is set up (install-wide). `POST /auth/login` already
answered unknown and wrong-password the same (dummy scrypt). Tests compare bodies and average timings.

## Bearer authentication

`router.ts`: a request with `Authorization: Bearer` skips the CSRF header check and never resolves the cookie (also on
`auth: 'none'` routes). `sessionResolver` hands it to `resolveApiKey`: per-address failure limit, key format, prefix
lookup + hash, revoked/expired, IP allow-list, `bearerAllowed(method, path)` (Data API only), token-bucket rate limit
per key (`Retry-After`), service account active, environment header must match the key's. The context is
`userContextFor(serviceAccount, key.environmentId)`, so the security engine applies the account's roles.

## Tables (schema version 7)

See [schema.md](schema.md#identity-p0-package-i). The sign-in log is a candidate for a projected system table (package N):

```
ab.signin_log (
  id bigint identity PK, at timestamptz, user_id text NULL (no FK: outlives the account), email text NULL,
  outcome text ('success'|'failure'), reason text, method text, ip text, user_agent text,
  session_id text NULL (the session's public id), device_hash text NULL, new_device boolean
)  indexes (at DESC), (user_id, at DESC)
```

## Tests

- `server/core/identity/totp.test.ts`: RFC 4226 and RFC 6238 vectors (SHA-1/256/512), window, Base32, URI.
- `server/core/identity/smtp.test.ts`: MIME, header injection, dot-stuffing; against the fake server: AUTH PLAIN/LOGIN,
  STARTTLS, implicit TLS, certificate verification, refusing to send a password in clear, 4xx/5xx.
- `server/core/identity/identity.integration.test.ts` (PostgreSQL): every flow and the abuse cases listed in its header.
- `scripts/docs-shots/identity.mjs`: headless browser run (invite, TOTP, recovery code, forgot password, session revoke
  from a second context, API key with curl, demo mode).
