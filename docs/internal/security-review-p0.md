# Security review of Phase 0 (package M)

Internal review of everything Phase 0 added (packages A to N), done at the phase close on 18 Nov 2026 by reading the code
and then attacking it with tests. It is a review by the people who built it, not an outside audit (that comes before the
pilot goes beyond one company, master plan section 5). Each area lists what was tested, what was found, what was fixed and
what remains. Severity is for this product's threat model ([security model](../admin/security-model.md#threat-model)):
one PC, trusted administrators and makers, untrusted ordinary users and web pages.

Tests named here: `server/core/security-p0.integration.test.ts` (S-I), `server/core/security-p0.test.ts` (S-U),
`server/core/phase-close.integration.test.ts` (PC), plus the existing suites they extend.

## Findings

| # | Area | Finding | Severity | Fixed |
| --- | --- | --- | --- | --- |
| 1 | Jobs and schedules | Any environment administrator could create a schedule of **any** job type with any payload, and change, run or delete install-wide schedules: an install backup on demand, the mail job, or (with 2d) the sign-in log retention set to 7 days to erase sign-in history. | Medium | Yes: `JobTypeDef.schedule` (`custom` / `install`); custom schedules only for safe types, install-wide ones need an install administrator. PC "custom schedules", "sign-in and email delivery logs". |
| 2 | Uploads (data files, model import) | A 25 MB `.xlsx` zip bomb is unpacked in memory by ExcelJS: **any maker** could exhaust the server's memory. | Medium | Yes: `server/core/zip-guard.ts` checks the ZIP directory first (256 MB unpacked, 200x ratio, 10,000 parts, no ZIP64). S-U "zip bombs". |
| 3 | Outbound connections (SSRF) | Database connections and the SMTP relay accepted any host, including `169.254.169.254` (cloud metadata) and `0.0.0.0`. | Low on a PC, Medium in a cloud VM (administrators only) | Yes: `server/core/net-policy.ts`; literal and resolved addresses checked; SMTP connects to the checked address. Policy documented. S-I "outbound hosts", S-U "outbound host policy". |
| 4 | Directory | Any signed-in user could list the names and emails of **every active user of the install** through `GET /api/v1/org`, including people with no access to the environment. | Low (names and emails) | Yes: `/org` lists only the rows of the Users system table the caller may read (environment access), plus the new "Directory visibility" setting (2h). PC "directory visibility". |
| 5 | Query v2 | A non-administrator's grouped aggregate over Comments or Activities failed (PostgreSQL 42P01, answered as 404): the natural-order aggregate aliased the table and the regarding predicate's correlated semi-join names the outer table. Not a leak (it failed closed), but a broken feature. | Bug (no leak) | Yes: no alias (`aggregateNatural`). PC "a grouped aggregate over a collaboration table". |
| 6 | Backups | Restore of a crafted archive: a pax header or the manifest/catalog member could claim gigabytes and be read whole into memory (install administrator uploads only). | Low | Yes: pax headers capped at 64 KB, whole-member reads at 256 MB (`archive.ts`). S-U "crafted backup archives". |
| 7 | Data model designer | Hostile DBML (long lines, many unterminated comments) made the browser's parser backtrack for seconds to minutes (self-inflicted, client only). | Low | Yes: lines over 4,000 characters skipped, texts over 2 MB refused. S-U "DBML import". |
| 8 | Summary tables | Two refreshes of one summary table at the same time each deleted what they saw and both inserted: duplicated totals until the next refresh. Found by the 2a test. | Bug (integrity) | Yes: the refresh locks the table first. |
| 9 | Computed columns | Formula columns and rollups are computed as the system: a rollup shows totals over child rows the reader cannot open, a formula column can show a function of a hidden column. | By design | Rule decided and documented ([security model](../admin/security-model.md#data-access-and-sql)); warnings added to the rollup and formula column editors. |
| 10 | Dependencies | `npm audit --omit=dev`: `uuid` < 11.1.1 (GHSA-w5hq-g745-h8pq, moderate) through `exceljs`. The flaw needs the `buf` argument of v3/v5/v6; ExcelJS only calls `v4()` without it. | Not exploitable here | No: needs an `overrides` entry for `uuid` in package.json (left for the release owner of package.json; `npm audit fix --force` would downgrade ExcelJS). |
| 11 | Query v2 on reporting views | Reading a reporting view tried to build the natural-order index on the view in the background (logged error, retried each time). | Bug (no security impact) | Yes: views skipped. |

## Areas reviewed

| Area | What was tested | Result |
| --- | --- | --- |
| Environment isolation | Header and `?env=` naming an environment without access; a made-up environment id with SQL in it; requests after access removal (existing `environments.integration.test.ts`); caches keyed by environment (`env-context.test.ts`). S-I "environment selection". | No finding. The schema name never comes from the client. |
| Query v2 plan injection | Crafted identifiers, operators, sort directions, forged and foreign cursors, page size 100,000, an `in` list of 50,000, a 3,000-deep condition, quoted measure names. S-I "Query v2 plans". | All 4xx before SQL; deep plans refused in milliseconds (node and depth limits); no ReDoS in `checkPlan` (no backtracking patterns on user text). |
| Semi-joins and `via` from clients | Lookup paths to a hidden column of a related table; related rows under the related table's own row predicate (existing `query-v2.integration.test.ts`, `core-data-model.integration.test.ts`). S-I "hidden columns". | No finding. |
| Hidden-column inference | Filter, sort, search, group, sum, count-with-filter and lookup paths over a hidden column, v1 and v2. S-I "hidden columns cannot be inferred". | All refused (403). Residual: timing of an allowed count over visible rows says nothing about hidden ones. |
| Formula columns, events as caller vs system | Read: events run as the caller unless an administrator sets "run as system" (audited, confirmed again on import); computed columns are system values (finding 9). | Documented rule and UI warnings. |
| Rollups over unreadable children | Rule decided: by design, documented, maker warned in the editor (finding 9). | Done. |
| WebSocket | Existing `live.integration.test.ts`: Origin required, Host allow-list, no cookie, environment and topic subscriptions checked per message, LEAK test (no foreign row ids or hidden column names), limits, slow consumers, sessions ending close sockets. | No finding. |
| Backup download links | Existing `backup.integration.test.ts`: one-use, one-minute tickets bound to user and backup, after a recent sign-in. | No finding. Residual: the ticket is in the URL (server log, browser history) for a minute. |
| Restore of crafted archives | Only regular members are listed (links, devices, directories ignored); `safeRel` refuses `..`, absolute, backslash and drive paths; checksums per file; caps (finding 6). S-U "crafted backup archives". | Fixed finding 6. Residual: an archive is not signed (a valid-looking archive with altered rows restores; whoever can upload one is an install administrator). |
| Uploaded release ZIPs (package L) | Read `server/core/update/zip.ts`: refuses absolute paths, `..`, drive letters, symbolic links and ZIP64, bounds inflate to the declared size, caps the total, checks CRCs. | No finding (not changed here). |
| API keys | Existing tests (Data API only, environment binding, expiry, IP allow-list, rate limit, revocation); S-U checks the new admin routes (export, directory, schedules) are out of a key's reach. | No finding. |
| Password reset and invitation tokens, TOTP | Existing `identity.integration.test.ts`: hashed single-use tokens, newer links revoke older ones, uniform timing, TOTP replay refused, brute force limits, recovery codes single use. | No finding. |
| CSV/Excel import | Import JSON bodies over 2 MB refused (413); data-file uploads 25 MB; formula injection guarded on every CSV the product writes, including the new export (S-U). | Finding 2 fixed. |
| Model import (DBML, Excel) | Finding 7 (DBML), finding 2 (Excel sheets for the model import go through the same parser). | Fixed. |
| Share and explainer endpoints | The explainer is administrators only (S-I); shares only add rows to users whose role already reads the table (existing `orgsec.integration.test.ts`). | No finding. |
| System-table writes | Inserts into Users, Roles, Audit entries, Sign-in log, Job runs, Notifications refused; admin-only Users columns refused in plans. S-I "system tables". | No finding. |
| Collaboration regarding-link spoofing | Comments about a row the user cannot read, about a table that does not exist, follows and timelines of unreadable rows. S-I "collaboration". | All refused. |
| Mentions and notifications leaking record data | Mentioning someone who cannot read the record is refused (422); notifications only to readers. S-I. | No finding. Residual: the 422 tells the writer that this person cannot read the record. |
| SSRF | Finding 3. Google Sheets talks to fixed Google hosts; there are no webhooks or HTTP connectors yet. | Fixed; policy documented. |
| Stored XSS | Rich text is sanitised on write and on render (allow-list, `http(s)`/`#` links only); notifications render as text; the diagram SVG escapes every name and only uses mapped colours and validated numbers; the TOTP QR SVG has no user text. S-U "escaping in exports". | No finding. |
| CSP | `script-src` with the hashes of the inline scripts of the served file, no `'unsafe-inline'` (existing `hardening.test.ts`); the 0.5.0 build was run in headless Chrome by the exit check (29 browser checks pass, so the hashed inline bundle runs). | No finding. `style-src` keeps `'unsafe-inline'` (documented). |
| Export environment data (new) | Administrators only, recent sign-in or a one-use ticket bound to user and environment, audited, formula-injection guard, no row or column security (administrators read everything). PC "export environment data". | Documented as an administrator power. |
| Directory visibility (new) | Everyone / department / administrators only applied in the Users predicate, `/org`, @mentions; self always visible. PC. | Done. |
| Dependencies | `npm audit --omit=dev` (finding 10). | Not fixed (see finding). |

## Residual risks (carried into the security model page)

- DNS rebinding between the outbound check and a database driver's own resolution.
- The ZIP guard trusts declared sizes; a library that does not stop at the declared size could still allocate more (ExcelJS
  uses JSZip, which checks sizes on inflate).
- Backup archives are verified but not signed.
- One-minute download tickets appear in URLs.
- Computed columns and rollups expose results over data the reader cannot see (by design, warned).
- An environment administrator can still turn on audit retention for their environment (minimum 30 days); the change is
  itself audited.
- No outside review yet.
