# Licensing and seat passes

How an Appbuilder install verifies its licence, what happens when it cannot, and how people get their passes. For the
operator of the licence service, see [Operating the licence service](#operating-the-licence-service) below. Design:
[hosting spec section 7](../plan/hosting-spec.md); code and formats: [docs/dev/licensing.md](../dev/licensing.md).

Pricing, tax on subscriptions (GST) and the contract terms are not part of this page: they are for the owner, an
accountant and a lawyer.

## In one paragraph

A licensed install asks the licence service at start and every 6 hours whether its licence is valid, and tells it how
many people hold each pass (three numbers, nothing else). The answer is signed; the install checks the signature and
keeps the last valid answer. If the service cannot be reached, the install keeps working on that answer for **72 hours
after it was issued**, and administrators see exactly when it will become read-only. After that the install is
**read-only** until a check succeeds: sign-in, reading, apps, dashboards and **export always keep working**. The next valid
answer makes it writable again at once. Nobody is ever locked out because of seat counts.

## Admin console > Licences

Shows: the licence id, plan, kind (subscription with paid-until, or lifetime for on-premises with the date until which
updates are included), the status, until when the last answer is valid, the last check and its result, and the seat
passes in use against the licensed seats. Install administrators have **Check now** (it also works while read-only: it
is the retry). When a check fails, a yellow panel says **"Becomes read-only at <date and time>"** (your time and UTC);
install administrators also get an in-app notification with the same time once, another one when the install becomes
read-only and one when it is writable again.

| You see | Meaning | What to do |
| --- | --- | --- |
| No licence configured | This install checks no licence and nothing is limited (development or evaluation) | Nothing; a licensed install has its three settings (below) |
| Active, no warning | Verified within the last 6 hours | Nothing |
| Becomes read-only at ... (service not reached) | The last checks failed; the install keeps working until the time shown | Check the server's internet connection and that it can reach the licence address; **Check now** |
| Becomes read-only at ... (unpaid / suspended) | The licence service reports the subscription unpaid or the licence suspended, with notice | Contact your provider |
| Read-only (licence) | No valid answer for 72 hours, the clock was set back, or another install uses this licence | Fix the connection or the clock, then **Check now** |
| Read-only (payment / suspended) | As reported by the licence service | Contact your provider; the install is writable at the next check after it is resolved |

**The server clock.** Moving the server's clock back by more than 5 minutes (behind a time the install has already seen)
makes the licence count as expired until the licence service answers again: setting the clock back does not extend the
3 days. Moving it forward only ends the 3 days sooner. Keep the server's time synchronised (NTP).

## The settings of a licensed install

Set in the install's environment (the instance file of a hosted install, which the fleet tool writes; the service
environment file of an on-premises install). The install key is a secret: prefer the key file.

| Setting | Value |
| --- | --- |
| `APPBUILDER_LICENCE_URL` | the licence service, `https://licence.<domain>` (`http://` only for `127.0.0.1` in tests) |
| `APPBUILDER_LICENCE_ID` | the licence id, `lic_...` |
| `APPBUILDER_LICENCE_KEY_FILE` (or `APPBUILDER_LICENCE_KEY`) | the install key, `abl_...` (a file readable only by the service account) |
| `APPBUILDER_LICENCE_CHECK_HOURS` | how often it checks (default 6) |
| `APPBUILDER_LICENCE_RETRY_MINUTES` | how soon it retries after a failed check (default 15) |
| `APPBUILDER_LICENCE_PUBLIC_KEY` / `_PUBLIC_KEY_FILE` | **tests and evaluations only**: replaces the licence public key built into the release (the Admin console shows that it is in use) |

All three of URL, id and key are needed; with only some of them set, the Admin console lists the problem and the install
behaves as one whose checks fail (its 72 hours run), so a typo does not switch the licence check off. With none set the
install behaves exactly as an install did before licensing existed. On-premises installs with a **lifetime** licence use
the same settings and the same online check; only the answer differs (no paid-until date).

## Seat passes

Every person holds one pass. Install administrators assign them in **Admin console > Users**: the **Pass** column (a
list per person) or select several people and choose **Set pass: Full user / Operator** (the bulk action). Every change is
in the install audit (`licence.pass_assign`).

| Pass | May | May not |
| --- | --- | --- |
| **Full user** | everything the person's roles allow, including Dev mode: Studio, the data model, flows, solutions, templates, print template design, administration | - |
| **Operator** | run apps on the web and the phone, approvals, dashboards, tasks, chat, notes, reports, export, and read and change data as the roles allow | Dev mode: no Studio, data model, flow designer, solutions, templates, connections, print template design or any other maker feature, even with a maker or administrator role (the server refuses them with "needs a Full user pass") |
| **External** | (external sites, a later phase) | counted, not assignable yet |

- **On upgrade every existing person holds a Full user pass**, so nothing changes for anyone until an administrator
  assigns Operator passes. New people also start with Full user.
- Service accounts (API keys) hold no pass and are not counted.
- **Counted**: people who are not disabled, per pass, invited people included. Disabling an account frees its seat.
- **Over the licensed seats** (soft enforcement): administrators see a warning on Admin console > Licences and in the
  Users page and get a notification. For **14 days** nothing else happens. After 14 days **new** assignments of that pass
  are refused until the counts fit again; nobody who already holds a pass loses it, nobody is signed out or locked out,
  and creating or importing people is not blocked (a new person starts with a Full user pass and is counted).
- An administrator holding an Operator pass can still administer (users, roles in Admin console, backups) but not build;
  give administrators who build a Full user pass.

## What the licence check resists, and what it does not

It resists: a changed or forged answer (the Ed25519 signature fails), an answer signed by any other key, an old answer
sent again (each answer carries the nonce of its own request), an answer for another organisation or install, editing
the stored answer in the database (it is verified again whenever it is used), setting the clock back (stored high-water
mark), and two installs sharing one licence for long (flagged at once, the older one read-only after 7 days).

It does **not** resist: someone with administrator rights on the server machine of an **on-premises** install, who can
change the program files, remove the licence settings (the install then behaves as unlicensed), or edit the stored time
of the last answer in the database. That is accepted: the licence is a commercial arrangement backed by the contract, not
a technical lock. Hosted installs are run by the operator, so their customers cannot do this. The licensing is not
tamper-proof and is not described as such anywhere.

## Operating the licence service

A separate process from the same release, with its own PostgreSQL database and role (`ab_licence`), on the fleet server
as `licence.<domain>` behind Caddy (or with its own TLS certificate). It needs nothing of an install.

```
node server/licence-service/main.ts <command>          (or: node server/main.ts licence-service <command>)
```

Environment: `APPBUILDER_LICENCE_DB_URL=postgres://ab_licence:<password>@127.0.0.1:5432/ab_licence`,
`APPBUILDER_LICENCE_SIGNING_KEY=<private key file>`, `APPBUILDER_LICENCE_KEY_PASSPHRASE_FILE=<file>`,
`APPBUILDER_LICENCE_HOST` / `_PORT` (127.0.0.1:7090), `APPBUILDER_LICENCE_TRUST_PROXY=1` behind Caddy,
`APPBUILDER_LICENCE_TLS_CERT` / `_TLS_KEY` without a proxy, `APPBUILDER_LICENCE_RATE_PER_MIN` (30 checks per address per
minute; 10 per install key).

| Command | Does |
| --- | --- |
| `keygen --out <folder> [--passphrase-file <f>]` | once: the Ed25519 signing key pair, encrypted with the passphrase, into a folder **outside the repository** (it refuses one inside). Keep the private key and the passphrase apart, with a backup; it is a different key from the release key. Its public key goes into `server/core/licence/licence-keys.json` for releases |
| `migrate` | creates the schema (also done by every command) |
| `serve` | the HTTPS-ready endpoint `POST /v1/licence/check` and `GET /healthz` |
| `org create --name <n> [--plan p] [--kind subscription\|lifetime] [--full n] [--operator n] [--external n] [--paid-until YYYY-MM-DD] [--notice-days n] [--maintenance-until YYYY-MM-DD]` | a customer organisation; prints its licence id (a subscription without `--paid-until` is paid for 30 days) |
| `org list` / `org show <org>` | organisations with state, seats, paid-until and last check; one with its install keys (ids only), installs, last check-ins and a duplicate warning |
| `key issue <org>` / `key rotate <org>` / `key revoke <org> [--key <id>]` | an install key, printed **once** (stored as SHA-256 only); rotate revokes the old ones. A revoked key gets "refused": the install becomes read-only when its last valid answer runs out (at most 72 hours) |
| `plan set <org> <plan>` / `seats set <org> [--full n] [--operator n] [--external n]` | plan and licensed seats |
| `payment record <org> --paid-until YYYY-MM-DD --reference <invoice or transfer>` | payment state (invoice and bank transfer; there is no payment integration) |
| `suspend <org> [--notice-days n] [--message t]` / `resume <org>` / `cancel <org> [--notice-days n]` | read-only from the next check (or after the notice); resume ends it |
| `checkins <org> [--limit n]` | time, install id, version, seat counts and outcome of each check |
| `install release <org> <install id>` | an install that was moved or removed: it is no longer counted for duplicates |
| `audit [--limit n]` | the operator audit (every command, its OS user, organisation and result, also failures) |

**Unpaid subscriptions**: when the paid-until date has passed, answers say "unpaid" and the install becomes read-only
`notice days` (default 14) later, with a warning that names the time; nothing is ever deleted.
**Two installs on one licence**: flagged in `org list` / `org show` as soon as two installs check in within a day; after 7
days of that, the install set up earlier is answered "duplicate" (read-only there) until the operator releases it.
**What the service stores**: organisations, plans and seats, payment references, hashed install keys, installs (id,
version, seat counts, first and last check) and check-ins. No names, emails or addresses of people; no client IP
addresses (the rate limit keeps them in memory only).

Exit check: `node scripts/exit-check/h-licence.mjs` (developers and CI) runs a real licence service and a real install
through every case above.
