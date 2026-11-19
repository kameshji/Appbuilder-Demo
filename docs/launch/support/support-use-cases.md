# Support use-case catalogue

Status: working draft, 19 Nov 2026, for version 0.5.0 (BRIEF: no customer yet; this is what we expect, not what we have
seen). Every cause and diagnosis step is derived from the repository docs (`docs/admin`, `docs/guide`, `docs/dev`) and a
look at the portal strings in `src/portal` and `src/controls`; **no UI is described that those do not describe**. Where
something is not confirmed the case says **verify** (check in the running product or with engineering before replying).

How to read a case:

- **Customer says**: the symptom in the customer's own words (English, sometimes Hinglish).
- **Likely cause**, **Diagnose** (exact page names; "Admin console > X" is the left-hand menu of the Admin console, in Dev
  mode, administrators only), **Resolve**, **Prevent**.
- **Sev / min / gap**: severity (S1 to S4, see [support-model.md](support-model.md#4-severity-definitions)), typical handling
  minutes for us, and whether it is a **product gap** (and which roadmap phase of the master plan the fix belongs to, or
  "doc" when it is a documentation gap only).
- Shortcuts used: **Test as user** and **Who can see a row?** (Security roles page, administrators); **diagnostics bundle** =
  Admin console > Server logs > Diagnostics bundle (or `appbuilder diagnostics --out bundle.zip`);
  **Server logs** = Admin console > Server logs.
- Roadmap labels: P1 automation (flows and approvals: in progress; notifications and scheduled reports exist), P2 reach
  (phone layouts, PDF, dashboards, WhatsApp, templates), P3 collaboration and licence passes, P3.5 single sign-on and
  passkeys, P4 agents, P5 documents, P6 external portal sites. See [BRIEF](../BRIEF.md) for what exists.

Groups: [Installation and updates](#1-installation-and-updates) - [Sign-in and two-step verification](#2-sign-in-and-two-step-verification) -
[Users, roles, security](#3-users-roles-and-security-why-cant-x-see-y) - [Environments and deploy](#4-environments-and-deploy) -
[Data import and tables](#5-data-import-and-tables) - [Formulas and delegation](#6-formulas-and-delegation-errors) -
[Apps and UI components](#7-apps-and-ui-components) - [Validation, rollups, events](#8-validation-rollups-and-events) -
[Live updates and conflicts](#9-live-updates-and-conflicts) - [Notifications and email](#10-notifications-and-email-delivery) -
[Scheduled reports](#11-scheduled-reports) - [Backup, restore, disaster](#12-backup-restore-and-disaster) -
[Performance](#13-performance) - [Licensing and passes](#14-licensing-and-passes-planned) -
[Integrations](#15-integrations-connectors-webhooks-api-keys) - [Browser, network, LAN, HTTPS](#16-browser-network-lan-https) -
[Printing and export](#17-printing-and-export) - ["How do I..." that are feature gaps](#18-how-do-i-requests-that-are-really-feature-gaps)

## 1. Installation and updates

### INS-01 "The script will not run" (PowerShell says running scripts is disabled / access denied)
- **Customer says:** "I double-clicked install.ps1 and nothing happens / it says scripts are disabled."
- **Likely cause:** not started the documented way, or PowerShell not elevated. The installer needs an elevated PowerShell and is started as `powershell -ExecutionPolicy Bypass -File .\scripts\install\windows\install.ps1` ([Installation](../../admin/installation.md#install-on-windows)).
- **Diagnose:** ask for a screenshot of the window title ("Administrator: Windows PowerShell") and the exact command typed. `-WhatIf` shows every step without changing anything.
- **Resolve:** Start > PowerShell > right-click > Run as administrator; `cd` into the unpacked release folder; run the documented command. Re-running is safe (it repairs).
- **Prevent:** onboarding call with their IT person; print the three lines.
- **Sev / min / gap:** S3 · 15 · none.

### INS-02 Installer stops with an ERROR before installing
- **Customer says:** "It says not enough memory / disk / unsupported Windows."
- **Likely cause:** the installer checks Windows version, 64-bit, memory (minimum 4 GB on Windows, 2 GB Linux), free disk (3 GB Windows, 2 GB Linux) and rights, and refuses less ([Requirements](../../admin/installation.md#requirements-and-sizing)). `-Force` exists for an untested Windows version.
- **Diagnose:** the ERROR line says which check failed; ask for it verbatim and for `systeminfo` or the PC specs.
- **Resolve:** free disk space or choose a bigger machine; do **not** use `-Force` on a customer's production PC unless we have tested that Windows version. Note the 8 GB recommended size for 20 to 50 users.
- **Prevent:** sizing check before the first call ([onboarding step 1](support-model.md#11-customer-onboarding-checklist)).
- **Sev / min / gap:** S3 · 20 · none (the Windows installer has not run on real Windows; every such report is valuable feedback, record it).

### INS-03 Downloads fail during install (no internet, proxy, firewall)
- **Customer says:** "Install fails while downloading Node / PostgreSQL."
- **Likely cause:** the installer downloads about 450 MB (Node.js, PostgreSQL, WinSW, Caddy) over HTTPS from pinned URLs and checks SHA-256; an office proxy or blocked host breaks it.
- **Diagnose:** which file failed (the ERROR names it); can the PC open the URL in a browser; checksum mismatch means a changed or truncated download (the installer deletes it and stops).
- **Resolve:** use the **offline bundle**: prepared on any computer with internet using `prepare-offline.mjs --os windows`, then `install.ps1 -Offline <folder>` ([Offline install](../../admin/installation.md#offline-install)).
- **Prevent:** ask about internet and proxy at the pre-sale call; for Linux, PostgreSQL 15+ must already be installed offline.
- **Sev / min / gap:** S3 · 30 · none.

### INS-04 SHA-256 of the release zip does not match
- **Customer says:** "The hash is different from your email."
- **Likely cause:** incomplete or altered download, or we sent the hash of a different build.
- **Diagnose:** `Get-FileHash .\appbuilder-<version>.zip` against the value we published; `appbuilder verify-release <zip>` after install exists; compare file size.
- **Resolve:** download again from the same link; do not install a zip whose hash differs. If it still differs, **we** check our own upload before blaming the customer.
- **Prevent:** always send the hash in a separate message from the link; sign releases (see [Update policy](support-model.md#8-update-policy): `release-keys.json` is empty today, so releases are unsigned).
- **Sev / min / gap:** S2 (possible tampering) · 15 · gap: signing key not made yet (release process).

### INS-05 "The setup code is missing or wrong"
- **Customer says:** "The first-run screen asks for a code. Where is it?"
- **Likely cause:** the code is shown in the server window or, for the installers, in `C:\ProgramData\Appbuilder\workspace\setup-code.txt` (or `/var/lib/appbuilder/workspace/setup-code.txt`); it changes at every start; 20 wrong codes in 15 minutes block more tries ([First-run setup](../../admin/installation.md#first-run-setup)).
- **Diagnose:** was the service restarted since they read the code? Were they typing a lower-case O for zero (the code alphabet has no look-alikes)?
- **Resolve:** read the file again in an elevated PowerShell (`Get-Content ...setup-code.txt`), type it with or without the dash. If blocked: wait 15 minutes or restart the service for a new code.
- **Prevent:** do the setup immediately after install, with us on the call.
- **Sev / min / gap:** S4 · 10 · none.

### INS-06 "This can only be done on the computer that runs Appbuilder"
- **Customer says:** "I opened the setup from my laptop and it refuses."
- **Likely cause:** the setup screen refuses any other computer and any request through the HTTPS/proxy address, by design.
- **Diagnose:** which address are they using? Anything other than `http://localhost:5174` on the server itself (or an SSH tunnel) is refused.
- **Resolve:** open `http://localhost:5174` on the server PC (Start menu > Appbuilder), or `ssh -L 5174:127.0.0.1:5174 user@server` and `http://localhost:5174` on their laptop (Linux). Do the setup, then use the HTTPS address.
- **Prevent:** say it in the onboarding call.
- **Sev / min / gap:** S4 · 5 · none.

### INS-07 "Port 5174 is already in use"
- **Customer says:** "The server window says Port N is already in use."
- **Likely cause:** another program uses the port, or a second copy of Appbuilder is running.
- **Diagnose:** `Get-Service Appbuilder` (is the service already running?); in source installs the message says "Set PORT to another value" ([Troubleshooting](../../guide/troubleshooting.md#port-already-in-use)).
- **Resolve:** stop the duplicate, or change the port (the installer option `-Port`, then Caddy and shortcuts follow); do not change `APPBUILDER_HOST`.
- **Prevent:** do not run the source version and the installed service together.
- **Sev / min / gap:** S3 · 15 · none.

### INS-08 After a reboot "Appbuilder is not opening"
- **Customer says:** "Monday morning the page does not load."
- **Likely cause:** services have not started (Windows: delayed automatic start after PostgreSQL), PostgreSQL service down, disk full, or the PC is not on.
- **Diagnose:** `Get-Service Appbuilder, appbuilder-postgresql, Appbuilder-Caddy`; `appbuilder health` (`ok`, `starting`, `degraded`, `down`); `GET /api/v1/health` (503 `starting` means the database is not reachable yet, for less than two minutes); the service logs in `C:\ProgramData\Appbuilder\logs`. See [runbook 2](runbooks.md#runbook-2-database-unreachable).
- **Resolve:** start the missing service; wait two minutes after boot; if `degraded` use runbook 2 or 6.
- **Prevent:** UPS; do not put the server PC to sleep; monitor `/api/v1/health` with any free external uptime checker on the LAN.
- **Sev / min / gap:** S1 if production is down, else S2 · 20 · gap: no alert when health fails ([Operations](../../admin/operations.md#not-supported-yet)), P0 follow-up.

### INS-09 The updater refuses the release (exit code 3)
- **Customer says:** "appbuilder update says refused."
- **Likely cause (documented refusals):** a downgrade; a release needing a newer Node.js than the service runs (run that release's installer instead); a release whose database schema is older than the database's; the running server is not healthy (`--force` overrides); a **signature** problem (unsigned or signed with another key by an install that trusts a key); a checksum mismatch (missing, changed or added files) ([Upgrades](../../admin/upgrades.md#update-an-installed-server)).
- **Diagnose:** ask for the printed lines; `appbuilder version` (installed release, schema version, trusted keys); `appbuilder verify-release <zip>`.
- **Resolve:** depends on the line; for an unhealthy server fix health first ([runbook 1](runbooks.md#runbook-1-server-will-not-start-after-an-update) or 2) rather than using `--force`.
- **Prevent:** run the update checklist; check Server logs is green before starting.
- **Sev / min / gap:** S2 · 30 · none.

### INS-10 Update failed and "rolled back"
- **Customer says:** "The update ended with an error and it went back to the old version."
- **Likely cause:** the new release did not answer health `ok` within the wait (default 10 minutes); the updater rolled the app folder back automatically and kept the failed release in `app.failed` (exit code 2).
- **Diagnose:** the updater's printed steps; `updates\history.json` / Admin console > Updates; diagnostics bundle (`release-check.json`, logs); did the schema change (release notes)? If it did, a pre-migration backup exists in the backup folder.
- **Resolve:** [runbook 1](runbooks.md#runbook-1-server-will-not-start-after-an-update); do not retry blindly. Send us the bundle and the `app.failed` folder's logs (not the folder).
- **Prevent:** a backup before; update on a quiet day; first three updates with us.
- **Sev / min / gap:** S2 · 60 · none (this is the designed safe path; log what failed as a bug).

### INS-11 "DATABASE NOT UPGRADED: the backup before the schema upgrade failed"
- **Customer says:** "After the update every page says it cannot reach data (503)."
- **Likely cause:** before migrating the schema the server takes an install backup; it failed (disk full, backup folder not writable) so it did **not** upgrade the database and does not retry ([Upgrades: What happens to the database](../../admin/upgrades.md#what-happens-to-the-database)).
- **Diagnose:** Server logs / the service log line; disk space (health, Usage); backup folder permissions.
- **Resolve:** fix the cause (free space, set the backup folder on a bigger disk), restart the service; only as a last resort and with a manual backup in hand start once with `APPBUILDER_MIGRATION_BACKUP=skip`.
- **Prevent:** keep 20 GB plus 3 times the database size free; second disk for backups.
- **Sev / min / gap:** S1 · 45 · none.

### INS-12 "This database needs a newer Appbuilder" / "DATABASE NOT USED"
- **Customer says:** "The browser says the database needs a newer Appbuilder."
- **Likely cause:** an older release was started against a database a newer release already migrated (downgrade guard). Typical after a manual rollback of the app folder.
- **Diagnose:** `appbuilder version` vs the schema version in the message; `app` and `app.previous` folders.
- **Resolve:** start the newer release again, or restore the pre-upgrade backup into the database before starting the older code ([Upgrades: Roll back](../../admin/upgrades.md#roll-back), runbook 1).
- **Prevent:** never swap `app` and `app.previous` by hand when the release notes say the schema changed.
- **Sev / min / gap:** S1 · 30 · none.

### INS-13 An environment shows "Failed" after an update
- **Customer says:** "One of our environments is greyed out in the picker."
- **Likely cause:** that environment's migration failed or a newer server migrated it; the server logs `ENVIRONMENT <id> NOT AVAILABLE`; others work ([Environments: When an environment is not available](../../admin/environments.md#when-an-environment-is-not-available)).
- **Diagnose:** Admin console > Environments (the reason is shown); audit `environment.migrate_failed` on the Install tab; diagnostics bundle `schema.json`.
- **Resolve:** it retries at every start; if the reason persists send the bundle; engineering fix; as a fallback restore the environment from a backup as a new environment.
- **Prevent:** staging environment updated first (a Sandbox copy of production on a spare PC).
- **Sev / min / gap:** S2 · 60 · none.

### INS-14 "Installer asks for a postgres password"
- **Customer says:** "It asks for the PostgreSQL superuser password; we do not know it."
- **Likely cause:** PostgreSQL 15+ already answers on `127.0.0.1:5432` (maybe from another product), so the installer uses it and asks once for the superuser password (not stored) ([Installation: What the Windows installer does](../../admin/installation.md#install-on-windows)).
- **Diagnose:** `Get-Service *postgres*`; who installed it. The hardening checklist says not to share the Appbuilder database with other applications.
- **Resolve:** either their DBA supplies the password, or install Appbuilder's own PostgreSQL by choosing `-Postgres Install` with a different `-PgPort` (verify the combination with a test machine).
- **Prevent:** ask at pre-sale whether PostgreSQL is already on the machine.
- **Sev / min / gap:** S3 · 30 · none.

### INS-15 "We uninstalled; where is our data? Can we reinstall?"
- **Customer says:** "We removed Appbuilder and want it back with the old data."
- **Likely cause:** uninstall keeps `C:\ProgramData\Appbuilder` and the PostgreSQL service with its data; `-RemoveData` deletes them after typing `DELETE <COMPUTERNAME>` ([Uninstall](../../admin/installation.md#install-on-windows)).
- **Diagnose:** do the folders exist; did they use `-RemoveData`?
- **Resolve:** run the installer again (it picks the data up). If data was removed: restore from backup ([runbook 3](runbooks.md#runbook-3-restore-from-backup-onto-a-new-pc)).
- **Prevent:** a copy of the latest backup off the machine before any uninstall.
- **Sev / min / gap:** S2 · 30 · none.

## 2. Sign-in and two-step verification

### SIG-01 "I forgot my password" (email works)
- **Customer says:** "Forgot password, mail nahi aaya."
- **Likely cause:** the reset email takes the Email relay; link works once for 15 minutes; at most 3 per address per hour; the screen answers the same for unknown addresses on purpose; mail may be in spam, or the relay is failing ([Sign-in and identity](../../admin/sign-in-and-identity.md#forgot-password)).
- **Diagnose (admin):** Admin console > Email > delivery log: queued, sent, retrying, failed and the last error; Jobs page `mail.send`.
- **Resolve:** check spam; if the relay is failing, fix it ([NOT-05](#not-05-the-email-relay-test-fails)) or create a **one-time reset code** (Users > menu > Create one-time reset code, 24 hours, shown once).
- **Prevent:** Send test email at onboarding; keep the second administrator.
- **Sev / min / gap:** S3 · 10 · none.

### SIG-02 Reset code does not work
- **Customer says:** "Admin gave me a code, it says invalid."
- **Likely cause:** code used already, older than 24 hours, a new code was created (older replaced? verify), typed email differs, or 10 wrong tries per client address in 15 minutes.
- **Diagnose:** sign-in log (reason "Invalid reset code"); Users > the person.
- **Resolve:** create a new code; person chooses **I have a reset code from an administrator**, types email, code and new password.
- **Prevent:** deliver the code on a different channel than email; tell them the 24-hour limit.
- **Sev / min / gap:** S3 · 10 · none.

### SIG-03 "That email and password do not match"
- **Customer says:** "Password sahi hai, phir bhi nahi chal raha."
- **Likely cause:** typo, caps lock, wrong email (the account email is stored in lower case), password never set (status "No password"), account disabled.
- **Diagnose:** Admin console > Users (Active, Disabled, No password, Must change password); Sign-in and security > sign-in log: reasons "Wrong password", "Unknown email", "Account disabled", "No password set".
- **Resolve:** per reason; use reset code or invitation.
- **Prevent:** invitations instead of passwords on paper.
- **Sev / min / gap:** S3 · 10 · none.

### SIG-04 "Too many attempts, wait and try again"
- **Customer says:** "It says too many attempts even with the correct password."
- **Likely cause:** 8 failed attempts for an email from the same computer within 15 minutes, or the per-email brake (from the 10th failure in an hour each attempt waits 1, 2, 4 ... seconds up to 5 minutes; 50 failures block the email for the rest of the hour). Anyone who knows an email can trigger the per-email wait (documented trade-off) ([Users and roles: Locked out by the login throttle](../../admin/users-and-roles.md#locked-out-by-the-login-throttle)).
- **Diagnose:** sign-in log filtered by "Too many attempts"; many from one address (a person) or from many (guessing).
- **Resolve:** wait up to 15 minutes; restarting the server clears the counters (use only if production can stand a one-minute interruption, and never to hide an attack).
- **Prevent:** password manager; investigate repeated bursts as a possible attack ([runbook 9](runbooks.md#runbook-9-suspected-unauthorised-access)).
- **Sev / min / gap:** S3 · 10 · gap: counters are per process and in memory; anyone can lock a known email (security model).

### SIG-05 Invitation link expired or "does not work"
- **Customer says:** "The link from the invitation mail does not open / says used."
- **Likely cause:** works once and for 7 days; resending replaces the old link; revoked; the account already has a password (cannot be invited, use a reset); the email's link starts with the **Public address** which may be wrong ([Email setup](../../admin/installation.md#set-up-email-smtp-relay)).
- **Diagnose:** Users list shows "Invited, until ..." or "Invitation expired"; Email > Public address.
- **Resolve:** **Resend invitation** (old link stops); or set a temporary password.
- **Prevent:** correct Public address before inviting a batch.
- **Sev / min / gap:** S3 · 10 · none.

### SIG-06 "Choose a new password" every time / right after signing in
- **Customer says:** "It keeps asking me to change password."
- **Likely cause:** an administrator set a temporary password (must change at first sign-in); or the password policy "Must change after N days" is on; the person closed the dialog and signed out before finishing.
- **Diagnose:** Users: "Must change password" status; Sign-in and security > Password policy.
- **Resolve:** type the temporary password as the current one and choose a new one (10+ characters, not common, not their email).
- **Prevent:** keep "Must change after" off unless a rule requires it (the docs cite NIST guidance).
- **Sev / min / gap:** S4 · 5 · none.

### SIG-07 New password refused
- **Customer says:** "Password rejected, but it is long."
- **Likely cause:** under the minimum length (10 by default), on the bundled list of 2,087 common passwords (also with digits or symbols appended), contains the email, one repeated character, or reused when "Cannot reuse the last N" is on.
- **Diagnose:** the message under the field; Sign-in and security > Password policy.
- **Resolve:** a few unrelated words.
- **Prevent:** tell users at training.
- **Sev / min / gap:** S4 · 5 · none.

### SIG-08 Authenticator code is rejected
- **Customer says:** "The 6-digit code says wrong, even new codes."
- **Likely cause:** phone or server clock wrong (the health page warns above 5 seconds difference between server clock and database server); code already used (each works once, "already used": wait for the next); 10 wrong codes lock the second step for 15 minutes; wrong account in the app.
- **Diagnose:** Server logs > health "clock"; Sign-in log reasons "Wrong code", "Code used twice", "Second step locked".
- **Resolve:** set the phone to automatic time; fix the server clock; wait out the lock; or sign in with a **recovery code**.
- **Prevent:** time sync on the server PC.
- **Sev / min / gap:** S3 · 15 · none.

### SIG-09 Lost phone, has recovery codes
- **Customer says:** "Phone kho gaya."
- **Likely cause:** normal.
- **Diagnose:** none needed; confirm they saved codes (Settings > Profile shows "Recovery codes left: N of 10" once signed in).
- **Resolve:** sign in with **Use a recovery code**; then Settings > Profile > turn the app off and set it up again on the new phone; make **New recovery codes** ([Signing in](../../guide/signing-in.md#lost-your-phone)).
- **Prevent:** codes in a password manager.
- **Sev / min / gap:** S3 · 10 · none.

### SIG-10 Lost phone, no recovery codes (a normal user)
- **Customer says:** "Phone and codes both gone."
- **Likely cause:** normal.
- **Diagnose:** is there another administrator?
- **Resolve:** an install administrator uses Users > the person's menu > **Reset two-step verification** (audited `user.mfa_reset`; signs them out everywhere); they sign in with password and set it up again.
- **Prevent:** at least two install administrators.
- **Sev / min / gap:** S3 · 10 · none.

### SIG-11 The only administrator is locked out by two-step verification
- **Customer says:** "Our admin lost the phone, there is no other admin. Nobody can enter."
- **Likely cause:** one install administrator, authenticator lost, no recovery codes. The docs say there is **no command-line password reset** and the only DB route is "an advanced step ... we have not documented a tested procedure" ([Users and roles: Locked out](../../admin/users-and-roles.md#locked-out); [Hardening](../../admin/hardening-checklist.md#first-run): create a second administrator).
- **Diagnose:** is any browser still signed in as that admin (idle timeout 7 days, longest 30 days)? Is the device remembered? Does an Email code exist as a second step?
- **Resolve:** see [runbook 5](runbooks.md#runbook-5-administrator-locked-out-with-two-step-verification): use a still-open session or email codes; otherwise there is no documented self-service recovery: **verify with engineering** (a tested one-off procedure is needed) and treat it as an S1/S2.
- **Prevent:** second install administrator at onboarding, recovery codes stored, two people hold them.
- **Sev / min / gap:** S1/S2 · 120+ · **gap: no tested admin recovery path** (P0 follow-up; the single worst sign-in gap).

### SIG-12 Email code never arrives
- **Customer says:** "Get a code by email, but no email."
- **Likely cause:** Email relay not set (the option is not offered), or failing; or email codes turned off in the policy ("Allow email codes").
- **Diagnose:** Email > delivery log; Sign-in and security > Allow email codes.
- **Resolve:** fix the relay or use the app/recovery code.
- **Prevent:** do not rely on email codes as the only second step.
- **Sev / min / gap:** S3 · 10 · none.

### SIG-13 "Your administrator requires two-step verification" and nothing else works
- **Customer says:** "It forces me to set up a code before I can do anything."
- **Likely cause:** policy "Required for" Administrators/Everyone (or per environment) and the **grace period** (default 7 days) ended: sign-in leads straight to setup, otherwise 403 `mfa_enrolment_required`.
- **Diagnose:** Sign-in and security policy; Settings shows "Your administrator requires it from ...".
- **Resolve:** complete the setup (Settings > Profile > Two-step verification > Set up authenticator app, save the 10 recovery codes).
- **Prevent:** announce before tightening the policy; grace period long enough for training.
- **Sev / min / gap:** S4 · 10 · none.

### SIG-14 "I was signed out suddenly"
- **Customer says:** "Baar baar logout ho jata hai."
- **Likely cause:** idle timeout (default 7 days), longest session (30 days), password changed or reset (all or other sessions end), account disabled, two-step reset, an administrator used "Sign out everywhere", or the server restarted with a different key.
- **Diagnose:** Users > Sessions; sign-in log; Settings > Profile > Active sessions; audit `auth.session_revoked`, `auth.sessions_revoked`, `user.session_revoked`.
- **Resolve:** sign in again; if repeated within hours check for an administrator/automation ending sessions, or the session policy values changed (audit `install.security_policy`).
- **Prevent:** keep defaults unless required.
- **Sev / min / gap:** S3 · 15 · none.

### SIG-15 "New sign-in to your account" email: is my account hacked?
- **Customer says:** "I got a security email about a new device."
- **Likely cause:** sent when an account signs in on a browser it was not signed in on before (policy "Email people about new devices", needs email); usually a new browser or cleared cookies.
- **Diagnose:** Settings > Profile > Active sessions and Sign-in history (last 50 with device and address); the address is a LAN address?
- **Resolve:** if recognised, nothing; if not, change password, **Sign out everywhere else**, tell the administrator, and see [runbook 9](runbooks.md#runbook-9-suspected-unauthorised-access).
- **Prevent:** explain the mail at training.
- **Sev / min / gap:** S3 (S1 if real) · 15 · none.

### SIG-16 Cannot change sign-in email
- **Customer says:** "I changed my email in Settings but nothing happens."
- **Likely cause:** needs Email set up and re-authentication; nothing changes until the link in the new address is opened (24 hours); without email an install administrator changes it in Users.
- **Diagnose:** Email delivery log for the confirmation to the new address; typed password within 10 minutes.
- **Resolve:** open the link, or administrator changes it.
- **Prevent:** none.
- **Sev / min / gap:** S4 · 10 · none.

### SIG-17 "Remember this device for 30 days" is missing, or users keep being asked for codes
- **Customer says:** "Why do I enter the code every time?"
- **Likely cause:** the policy "Remember a device for" is 0; the remembered device was forgotten (password reset forgets devices; Settings lists them); a different browser profile; cookies cleared.
- **Diagnose:** Sign-in and security policy; Settings > Profile.
- **Resolve:** set days if the customer accepts the risk; only on a computer only that person uses.
- **Prevent:** none.
- **Sev / min / gap:** S4 · 5 · none.

## 3. Users, roles and security: "why can't X see Y"

For every case below start the same way: **Admin console > Users** (is the person Active, with the right roles in **this
environment**?), then **Security roles > Test as user** for that person (per table: create/read/update/delete, whether a row
filter applies, how many rows and *why*, hidden and read-only columns), then **Who can see a row?** for one concrete row
([Users and roles](../../admin/users-and-roles.md#test-as-user)). Test as user shows what the rules give; it does not sign you in as them.

### SEC-01 "I can see nothing" (new user)
- **Customer says:** "Login ho gaya par koi app nahi dikha / table does not exist."
- **Likely cause:** the person has no role in this environment: no apps and "table does not exist" for every table ([Create a user](../../admin/users-and-roles.md#create-a-user)); or they have access to another environment only.
- **Diagnose:** Users > roles column; Environments > Access.
- **Resolve:** give a role (it also lets them in).
- **Prevent:** onboarding script: create user, assign role, Test as user.
- **Sev / min / gap:** S3 · 5 · none.

### SEC-02 "I see only my own records"
- **Customer says:** "Supervisor ko sirf apni entries dikh rahi hain."
- **Likely cause:** scope **Own** (rows whose `owner` is the user); the role was meant to be Team, Department, Direct reports or a row rule.
- **Diagnose:** Test as user > the table > the reason line per role and scope; Who can see a row?.
- **Resolve:** change the role's scope or add a row rule (e.g. `Line > Supervisor is the current user`); check Organisation data feeds it.
- **Prevent:** write the access matrix on one page before building roles.
- **Sev / min / gap:** S3 · 20 · none.

### SEC-03 Manager does not see the team's rows (Direct reports / Reporting line)
- **Customer says:** "Manager ko team ka data nahi dikh raha."
- **Likely cause:** the team members' **manager** field is empty or points to someone else (Admin console > Users / Departments / Teams / Org chart); a user with no department gets only their own rows under Department scopes.
- **Diagnose:** Org chart; Users > person > manager/department; Test as user for the manager.
- **Resolve:** fix the organisation data (CSV import updates managers by email); changes apply on the next request.
- **Prevent:** import the org via CSV with the check preview; review after joiners and leavers.
- **Sev / min / gap:** S3 · 20 · none.

### SEC-04 Rows from a linked table are invisible to everyone but admins
- **Customer says:** "We linked our old table; nobody sees old rows."
- **Likely cause:** rows that existed before linking have no owner, so owner-based scopes cannot see them; a linked table without an `owner` column grants nothing to owner scopes.
- **Diagnose:** Test as user shows 0 rows for an Own/Team scope; Who can see a row?.
- **Resolve:** Tables > the table > Settings > **Assign owner to rows without owner** (Assign to me) ([Own scope](../../admin/users-and-roles.md#which-rows-scopes)); or use a role with All scope.
- **Prevent:** decide ownership before linking.
- **Sev / min / gap:** S3 · 15 · none.

### SEC-05 "Imported data disappeared for everyone else"
- **Customer says:** "I imported a CSV; my colleagues cannot see those rows."
- **Likely cause:** imported rows get the **importing user** as `owner` and `createdBy`, so Own/Team scopes follow the importer.
- **Diagnose:** Who can see a row? for an imported row.
- **Resolve:** the importer imports as an administrator for an All-scope role, or re-own rows; teams: "Rows can be owned by teams" setting.
- **Prevent:** a convention: imports done by a data-owner account.
- **Sev / min / gap:** S3 · 20 · doc (the import page does not warn about it; see README feedback).

### SEC-06 "You do not have access to this app"
- **Customer says:** "App open karte hi access error."
- **Likely cause:** the app is not in any of the person's roles' **App access** (a new role starts with no apps); non-makers do not see other apps in the list.
- **Diagnose:** Security roles > the role > Apps; Test as user.
- **Resolve:** add the app (or All apps) to the role.
- **Prevent:** role checklist per app.
- **Sev / min / gap:** S3 · 5 · none.

### SEC-07 App opens but data is empty or "Could not add/save/delete"
- **Customer says:** "App khul gaya par list khali hai."
- **Likely cause:** app access is not data access: the role needs **table privileges** on every table the app uses ([App access](../../admin/users-and-roles.md#app-access)); new tables give default privileges only to Maker-like and Viewer roles; restricted roles get none.
- **Diagnose:** Test as user > each table the app reads.
- **Resolve:** give the role Read/Create/Update/Delete per table.
- **Prevent:** after adding a table to an app, re-run Test as user.
- **Sev / min / gap:** S3 · 15 · none.

### SEC-08 A column is missing or locked
- **Customer says:** "Salary column ghayab hai" / "I cannot edit Status, it has a lock."
- **Likely cause:** column security: None hides, Read locks (notes "Read-only columns for you: ..."); system columns (`id`, `createdOn`, `modifiedOn`, `createdBy`, `owner`) are never writable.
- **Diagnose:** Test as user > hidden and read-only columns.
- **Resolve:** change the role's Columns setting if intended; otherwise explain.
- **Prevent:** maker designs forms knowing which roles see what.
- **Sev / min / gap:** S4 · 10 · none.

### SEC-09 "He has two roles but still cannot see it"
- **Customer says:** "Role add kiya par kuch badla nahi."
- **Likely cause:** roles **add**: the broadest wins per part; there is no deny. Perhaps the added role has no table privilege, or the added role's rows are limited by a rule; or the new role has no app access.
- **Diagnose:** Test as user lists one line per role that grants read.
- **Resolve:** grant it in the role that should; put restrictions in a single role given only to restricted people.
- **Prevent:** keep roles few and purpose-named.
- **Sev / min / gap:** S3 · 15 · gap: no deny rule (planned? not in plan; log as product gap "denying access that another role grants").

### SEC-10 A row rule "stopped working"; the role now sees nothing
- **Customer says:** "Kal tak sab dikh raha tha, aaj kuch nahi."
- **Likely cause:** a rule that no longer fits the table (a column or lookup was removed or changed) makes that role grant **nothing** (fails closed); or a rule compares with a value the user does not have (no department, no manager, unknown code): never matches.
- **Diagnose:** Test as user (0 rows, reason); Security roles > the role > Columns and rows > Row rules (the editor refuses invalid rules when saved); audit `column.remove`/`column.update`.
- **Resolve:** fix the rule or restore the column.
- **Prevent:** after any column change, re-run Test as user for each role on that table.
- **Sev / min / gap:** S2 (many users) · 30 · none.

### SEC-11 A restricted user sees a total they should not (rollup/formula column)
- **Customer says:** "Operator can see total of everyone's lines."
- **Likely cause:** a rollup or formula column is calculated over **all** related rows, and everyone who can see the column sees the result ([Rollups](../../guide/maker/data.md#rollups)).
- **Diagnose:** Test as user shows the column visible.
- **Resolve:** limit the rollup column in the table's column security for that role.
- **Prevent:** maker training: private related rows plus rollups need column security.
- **Sev / min / gap:** S2 (data exposure) · 20 · gap: documented behaviour but surprising (security model "Formula columns and rollups show results computed over data the reader may not see").

### SEC-12 "Could not add in Orders" when a restricted user saves
- **Customer says:** "Region East mein entry nahi ho rahi."
- **Likely cause:** row filters check what is **written**: a new row must match the filter of a role that grants Create; an update must satisfy the Update rule before and after; so West-only users cannot create East rows or edit a West row into East.
- **Diagnose:** the toast text "Could not add/save/delete in <table>: <reason>"; Test as user.
- **Resolve:** widen the role's Create/Update rule or have another role do it.
- **Prevent:** include write cases in the role test script.
- **Sev / min / gap:** S3 · 15 · none.

### SEC-13 Sharing a single record does not work
- **Customer says:** "Maine record share kiya par usko nahi dikh raha."
- **Likely cause:** table's **Record sharing** is off; the recipient has no Read role on the table at all (a share only adds rows to what the role allows); shares never grant Delete; only the owner or roles with a Share scope can share; the share was withdrawn; sharing turned off hides shares.
- **Diagnose:** Who can see a row? for the row; table designer > Settings > Ownership and sharing.
- **Resolve:** give the recipient a role with Read; turn sharing on.
- **Prevent:** explain in training.
- **Sev / min / gap:** S3 · 15 · none.

### SEC-14 Person pickers, @mentions and share lists are empty or missing people
- **Customer says:** "Mention karte time naam nahi aata."
- **Likely cause:** **Directory visibility** (Admin console > Users): same department or administrators only; the person has no access to this environment; for @mention, the person must be able to read **that record**.
- **Diagnose:** Users > Directory visibility; Who can see a row?.
- **Resolve:** change the setting or give the person access.
- **Prevent:** decide directory visibility at onboarding.
- **Sev / min / gap:** S4 · 10 · none.

### SEC-15 A leaver's rows vanished after "Delete user"
- **Customer says:** "We deleted Ramesh's account and his records disappeared for his team."
- **Likely cause:** delete leaves the old user id in `createdBy` and `owner`, so owner-based scopes no longer match anyone; rows become invisible except to All-scope roles. Disable would have kept everything ([Disable or delete](../../admin/users-and-roles.md#disable-or-delete-a-user)).
- **Diagnose:** audit `user.delete`; Who can see a row?.
- **Resolve:** an administrator re-owns the rows (verify the supported way: Assign to me is for rows with **no** owner; for rows with a deleted owner id **verify with engineering**); a restore of selected tables is a heavier option.
- **Prevent:** always **disable**, never delete.
- **Sev / min / gap:** S2 · 45 · gap: no re-owner tool for orphaned owners (verify; P0 follow-up).

### SEC-16 "Cannot disable this user" (last administrator guard)
- **Customer says:** "409 At least one active user must keep an administrator role."
- **Likely cause:** the guard: at least one active user and one active install administrator must remain; you cannot disable or delete your own account.
- **Diagnose:** Users > administrators.
- **Resolve:** make another administrator first.
- **Prevent:** second administrator.
- **Sev / min / gap:** S4 · 5 · none.

### SEC-17 "Not available for your role"
- **Customer says:** "Tables page says not available."
- **Likely cause:** Dev-mode pages (Tables, Connections, Solutions, Data files) need the Maker role; Security roles and Admin console need Administrator; people without Maker/Admin see only User mode.
- **Diagnose:** Users > roles.
- **Resolve:** grant Maker only to the few who build; Hardening checklist says as few as possible.
- **Prevent:** none.
- **Sev / min / gap:** S4 · 5 · none.

### SEC-18 "Who deleted / changed this row?"
- **Customer says:** "Someone changed the rate, who?"
- **Likely cause:** the audit log records **which columns** changed on a row update and by whom and when (UTC), but **not the old or new values**; reads are never logged; bulk deletes list at most 1,000 ids.
- **Diagnose:** Admin console > Audit log (environment tab and Install tab) filtered by table/row; `row.update` details `changes`; for older data a backup's read-only **Browse**.
- **Resolve:** tell them honestly what the log can and cannot show; restore of a selected table into a new table to compare values.
- **Prevent:** add a "history" pattern in the app (a comments timeline with a note on change) if they need values.
- **Sev / min / gap:** S3 · 30 · **gap: no old/new values, no read log** (audit log doc "What is not recorded"; P1-P3, not scheduled).

### SEC-19 "A user can read our app's formulas / see network traffic"
- **Customer says:** "Can staff see the formulas in the app?"
- **Likely cause:** by design anyone who can open an app can read its definition; hiding a UI component is not security.
- **Diagnose:** none.
- **Resolve:** explain; move secrets out of apps; use column security for data.
- **Prevent:** maker training.
- **Sev / min / gap:** S4 · 10 · none.

## 4. Environments and deploy

### ENV-01 "Environment limit reached"
- **Customer says:** "New environment button is disabled."
- **Likely cause:** at most **5** environments including Default and Failed ones (`APPBUILDER_MAX_ENVIRONMENTS`, 1 to 50).
- **Diagnose:** Environments list.
- **Resolve:** delete a failed or unused one (typed confirmation; a backup is taken first), or raise the variable and restart.
- **Prevent:** keep to Production + Sandbox + one Developer.
- **Sev / min / gap:** S4 · 10 · none.

### ENV-02 "This environment is locked"
- **Customer says:** "Production mein table change nahi ho raha, 403 locked."
- **Likely cause:** Production is **locked**: apps, tables, columns, roles, solutions and data files change only by deploying or importing a solution; the Studio opens apps read-only with a banner.
- **Diagnose:** the lock icon beside the environment name; Environments > Details > Locked.
- **Resolve:** make the change in Sandbox and **Deploy to...** Production; unlock only deliberately (an install administrator).
- **Prevent:** explain at maker training why it is locked.
- **Sev / min / gap:** S4 · 10 · none.

### ENV-03 The Studio is read-only
- **Customer says:** "Studio mein kuch edit nahi hota."
- **Likely cause:** another maker is editing the same app ("Read-only. <name> is editing this app."), or the environment is locked.
- **Diagnose:** the banner text; avatars next to the save state.
- **Resolve:** ask the other maker to finish or use **Take over editing** (the other's last changes are kept).
- **Prevent:** one editor per app by convention.
- **Sev / min / gap:** S4 · 5 · none (soft lock by design; no co-editing).

### ENV-04 The deploy plan shows red items
- **Customer says:** "Deploy plan mein red items hain, kya hoga?"
- **Likely cause:** destructive changes: a table or column removed in the new version loses its data; a type change converts values; "removed" means the previous version had it and this one does not ([Solutions](../../guide/maker/solutions.md#deploy-to-another-environment)).
- **Diagnose:** read the plan: new/changed/removed; whether a backup is promised ("A backup of this environment is taken before anything changes").
- **Resolve:** if unintended, cancel and fix the solution; if intended tick "I understand that the data in the red items is lost".
- **Prevent:** always Review plan; keep automatic backups on (Admin console > Backups > Settings).
- **Sev / min / gap:** S3 · 20 · none.

### ENV-05 The deployment is blocked by "Problems"
- **Customer says:** "Upgrade button is disabled."
- **Likely cause:** problems listed in the plan, for example a table that lives in another database in the target, a lookup to a table missing in both, or a kind change of a table (plain to view/summary), or repeated unique pairs in target rows.
- **Diagnose:** the plan's Problems section.
- **Resolve:** fix the cause in the solution or in the target data; nothing changed (one transaction).
- **Prevent:** deploy Sandbox to Production regularly, not once a year.
- **Sev / min / gap:** S3 · 30 · none.

### ENV-06 "Only an administrator can upgrade what exists there"
- **Customer says:** "Maker deploy nahi kar paya."
- **Likely cause:** upgrading an existing solution in the target needs its administrator (it changes apps, tables, roles others use); installing something new needs only the Maker role there.
- **Diagnose:** the user's roles in the target environment.
- **Resolve:** an environment administrator performs the upgrade.
- **Prevent:** deployment owner named in the runbook.
- **Sev / min / gap:** S4 · 5 · none.

### ENV-07 Deployed or copied environment cannot reach the other system
- **Customer says:** "Sandbox se ERP call fail ho raha, ya Production mein connection khali."
- **Likely cause:** connections arrive **without passwords or keys** in a new environment, copy or imported solution; connections existing in the target keep their own settings.
- **Diagnose:** Connections > Test; status "error".
- **Resolve:** open each connection and enter the secret.
- **Prevent:** list of connections and who holds the secrets (in the install record).
- **Sev / min / gap:** S3 · 15 · none (by design, good: a sandbox copy does not write to real systems).

### ENV-08 A copy of production has nobody in it
- **Customer says:** "Sandbox mein koi nahi aa sakta."
- **Likely cause:** copies never take people's roles; only the creator has access (as administrator).
- **Diagnose:** Environments > Access.
- **Resolve:** Give access / assign roles in the copy.
- **Prevent:** none.
- **Sev / min / gap:** S4 · 10 · gap: no way to copy roles along with a copy (listed under not supported in the environments doc).

### ENV-09 "Environment is being restored" / environment greyed out
- **Customer says:** "It says being restored and we cannot work."
- **Likely cause:** an in-place restore is running; the environment is in state Restoring and people are moved to another environment until it is back. Or it is Failed (INS-13).
- **Diagnose:** Backups page progress; Environments state.
- **Resolve:** wait; if it does not finish, [runbook 3](runbooks.md#runbook-3-restore-from-backup-onto-a-new-pc) references; a failure keeps the data (one transaction).
- **Prevent:** schedule restores outside shifts.
- **Sev / min / gap:** S2 · 15 · none.

### ENV-10 Import created duplicates instead of upgrading
- **Customer says:** "Imported the solution; now we have two copies of the app."
- **Likely cause:** **Import as a copy** gives new identities (never upgrades later); app packages always import as copies; packages exported before 0.5 have no solution id and import as copies.
- **Diagnose:** Solutions page; what was chosen in the import dialog.
- **Resolve:** delete the copies; import again (without "as a copy") from a package with a solution id, or use Deploy to....
- **Prevent:** use **Deploy to...** between environments.
- **Sev / min / gap:** S3 · 20 · none.

### ENV-11 An event "that runs as the system" will not import
- **Customer says:** "Solution import fails asking administrator."
- **Likely cause:** only an administrator may bring in an event that runs as the system, and must tick a box; importing as a copy brings such events switched off.
- **Diagnose:** the plan notes.
- **Resolve:** an administrator performs it and reviews the event.
- **Prevent:** avoid run-as-system events unless needed.
- **Sev / min / gap:** S4 · 10 · none.

## 5. Data import and tables

### DAT-01 CSV import loads blank columns
- **Customer says:** "CSV import kiya par columns khali hain."
- **Likely cause:** the header row must use **column names** (for example `CheckedOut`), not display names (`Checked out`); unknown columns are ignored.
- **Diagnose:** Tables > the table > Import CSV preview; compare headers with the Columns tab.
- **Resolve:** rename headers; import again.
- **Prevent:** use Export CSV from the table as the template.
- **Sev / min / gap:** S3 · 10 · gap: header matching by display name would be friendlier (P1 candidate).

### DAT-02 Import "replace" deleted our rows
- **Customer says:** "Import ne purana data hata diya."
- **Likely cause:** Import CSV can append or **replace**; replace deletes existing rows (audit `row.delete` with `import: true`).
- **Diagnose:** Audit log entries around that time.
- **Resolve:** restore the table's rows from the last backup into a new table and copy ([BKP-09](#bkp-09-accidental-deletion-of-rows)).
- **Prevent:** take **Back up now** (environment) before a replace import.
- **Sev / min / gap:** S2 · 45 · none.

### DAT-03 Add row / Import CSV are disabled
- **Customer says:** "Add row button grey hai."
- **Likely cause:** the role cannot create rows in that table.
- **Diagnose:** Test as user > Create.
- **Resolve:** grant Create.
- **Prevent:** none.
- **Sev / min / gap:** S4 · 5 · none.

### DAT-04 Excel formulas disappeared
- **Customer says:** "Our Excel sheet lost its formulas."
- **Likely cause:** editing a sheet of a data file in Appbuilder writes the stored copy with **values only**; date number formats may reset; macro-enabled workbooks are rejected; the original file is untouched.
- **Diagnose:** Data files > the file.
- **Resolve:** re-add the original file (Replace warns if data was edited since import); use the database for live data (**Move to database**).
- **Prevent:** training: data files are copies.
- **Sev / min / gap:** S3 · 10 · none.

### DAT-05 Upload refused (file too big or wrong type)
- **Customer says:** "File upload nahi ho rahi."
- **Likely cause:** Image/File columns accept up to 25 MB by default and can be restricted to types; Data files accept .csv, .xlsx, .json up to 25 MB.
- **Diagnose:** the column's settings; the file size.
- **Resolve:** compress, split, or the maker changes the accepted types.
- **Prevent:** state limits in the form label.
- **Sev / min / gap:** S4 · 10 · none (25 MB by default; can it be raised? verify).

### DAT-06 Table on MySQL / Google Sheets seems to have "missing" rows
- **Customer says:** "Search shows only some rows."
- **Likely cause:** tables on MySQL, data file and Google Sheets connections cannot run queries; Appbuilder works on the first 5,000 rows and warns ("only the first 5,000 rows are searched, sorted and counted").
- **Diagnose:** the data warning in the Studio status bar error list.
- **Resolve:** copy the table to the default database (Data files > Move to database, or import).
- **Prevent:** use the default database for anything larger than a few thousand rows.
- **Sev / min / gap:** S3 · 20 · none.

### DAT-07 Linking a table asks to add an id column
- **Customer says:** "Link table says it will add a column."
- **Likely cause:** a linked source without an `id` column needs one to locate rows; Appbuilder asks permission to add system columns.
- **Diagnose:** the dialog text.
- **Resolve:** allow it if the owner of that database agrees; otherwise add `id` yourself.
- **Prevent:** link only what you own; do not share the Appbuilder database with other applications.
- **Sev / min / gap:** S4 · 10 · none.

### DAT-08 Google Sheets: "Google denied access to the spreadsheet"
- **Customer says:** "Google Sheet connect nahi hoti."
- **Likely cause:** the sheet is not shared with the **service account email** as Editor, wrong id, or the Sheets API is not enabled for the key's project; key missing after a restore without `.secret-key`.
- **Diagnose:** Connections > Test (the message); the service account email in the connection dialog ([Connections: What the messages mean](../../admin/connections.md#google-sheets)).
- **Resolve:** share it; enable the API; paste the key again.
- **Prevent:** keep the key file in their password manager.
- **Sev / min / gap:** S3 · 20 · none.

### DAT-09 Dates are a day off or show the wrong time
- **Customer says:** "Date ek din pehle dikh rahi hai."
- **Likely cause:** unknown: possible time-zone handling for Date vs Date and time columns, or the person's Settings > Language and region > time zone; audit times are in UTC; **verify with engineering** how Date columns store and display across time zones.
- **Diagnose:** Settings > Language and region; the column type; a sample row via Test as user; compare in the table grid and in an app.
- **Resolve:** per finding.
- **Prevent:** Date (not Date and time) for plain dates.
- **Sev / min / gap:** S3 · 30 · verify.

### DAT-10 Invoice numbers: duplicates or gaps
- **Customer says:** "Do invoices ka same number aa gaya."
- **Likely cause:** number made by a formula such as `CountRows()+1` instead of a number sequence. Proper way: administrator adds a **number sequence** (Reference data), default `=NextNumber("Invoices")`; the server hands numbers out at save; two people never get the same one, and a failed save does not use one.
- **Diagnose:** the column's default value; Reference data > Number sequences.
- **Resolve:** switch to NextNumber; fix existing duplicates by hand.
- **Prevent:** training for makers.
- **Sev / min / gap:** S3 · 30 · none.

### DAT-11 "Value contains a NUL character" on save
- **Customer says:** "Paste karte waqt save fail."
- **Likely cause:** text pasted from some PDFs/other systems holds `\0`, which PostgreSQL text cannot store.
- **Diagnose:** the error text.
- **Resolve:** retype the value.
- **Prevent:** none.
- **Sev / min / gap:** S4 · 10 · none.

### DAT-12 A table, column or app was deleted by mistake
- **Customer says:** "Table delete ho gaya!"
- **Likely cause:** there is **no recycle bin** ([Users and roles: What makers and administrators can do](../../admin/users-and-roles.md#what-makers-and-administrators-can-do)); dropping a column or table removes its data.
- **Diagnose:** audit `table.delete`, `column.remove`, `app.delete` with time and user; last backup time.
- **Resolve:** restore the last backup **as a new environment**, copy the table back, or restore **selected tables as new tables** into the current environment (not for views or data-file tables); an app: export the package from the restored environment and import it ([runbook 10](runbooks.md#runbook-10-accidental-mass-delete)).
- **Prevent:** lock Production; Makers few; Sandbox for changes.
- **Sev / min / gap:** S2 · 90 · gap: no undo / recycle bin (not scheduled).

## 6. Formulas and delegation errors

"Delegation" here means: the formula must be answerable by the database. The Studio's formula bar shows **Runs on server**,
**Runs in browser** or **Can't run** ([Data: large tables](../../guide/maker/data.md#large-tables-what-runs-on-the-server)).

### FRM-01 "Can't run on the server: ..." red underline
- **Customer says:** "Formula error aa raha, table badi ho gayi."
- **Likely cause:** the formula cannot be turned into a database query (for example `Len(Title) > 3`, `Month(DueDate) = 3`, a division by a column, `Concat(Filter(...), ...)` over a whole table, a `LookUp` of another table inside a `Filter`) and the table is over 2,000 rows the user can see.
- **Diagnose:** the underlined part and the suggested rewrite; Studio error list > Formulas.
- **Resolve:** rewrite (compare the column itself: `DueDate < DateAdd(Today(), -7, "Days")`; `Year(DueDate) = 2026`; multiply instead of divide; read another table's value into a variable first; add a stored formula column; limit with `FirstN`).
- **Prevent:** watch the yellow "Runs in browser" label during build: it is a future error.
- **Sev / min / gap:** S3 · 30 · none (documented behaviour).

### FRM-02 It worked yesterday, now an app screen is blank / errors
- **Customer says:** "Kal tak chal raha tha, ab list khali."
- **Likely cause:** the table crossed 2,000 rows and a **Runs in browser** formula became an error (never a partial answer).
- **Diagnose:** Admin console > Usage (row counts); Studio status bar > Data warnings.
- **Resolve:** as FRM-01.
- **Prevent:** quarterly health check looks at table sizes; makers fix yellow labels immediately.
- **Sev / min / gap:** S2 (production screen blank) · 45 · none.

### FRM-03 "This query returns more than 5,000 rows / groups"
- **Customer says:** "Itne rows ka error."
- **Likely cause:** a formula asks for a very long list where it cannot page (for example in a variable) or groups by too many distinct values; pages hold at most 500 rows.
- **Diagnose:** the formula and where it is used.
- **Resolve:** `FirstN(..., n)`, filter further, group by fewer values.
- **Prevent:** none.
- **Sev / min / gap:** S3 · 20 · none.

### FRM-04 Totals differ between two people
- **Customer says:** "Mera total alag, boss ka alag."
- **Likely cause:** formulas over tables run in the database with each user's **row and column security**, so counts and sums cover only the rows that user may see; rollups and formula columns, in contrast, cover all related rows (SEC-11).
- **Diagnose:** Test as user for both; Who can see a row?.
- **Resolve:** explain; if a common total is intended, use a rollup column and limit who sees it, or report "run as" a service account (administrator decision).
- **Prevent:** document which totals are personal.
- **Sev / min / gap:** S3 · 20 · none.

### FRM-05 Column name with spaces does not work in a formula
- **Customer says:** "Formula mein column nahi mil raha."
- **Likely cause:** the formula name is the display name without spaces ("Checked out to" becomes `CheckedOutTo`); renaming the display name changes it.
- **Diagnose:** Tables > Columns.
- **Resolve:** use the formula name.
- **Prevent:** keep display names stable.
- **Sev / min / gap:** S4 · 5 · none.

### FRM-06 A table event will not save: "function only makes sense in an app"
- **Customer says:** "Event save karte waqt error: Navigate not allowed."
- **Likely cause:** `Navigate`, `Notify`, `SubmitForm` and similar are refused in table events; `RunConnector` works only in **after**-save events.
- **Diagnose:** the explanation shown when saving.
- **Resolve:** use `NotifyUser`/`SendNotification` and table functions.
- **Prevent:** none.
- **Sev / min / gap:** S4 · 10 · none.

### FRM-07 Formula column shows blank for some rows
- **Customer says:** "Total column kuch rows mein khali."
- **Likely cause:** the formula cannot be calculated for those rows (division by zero, blank inputs); the problem is in the run log.
- **Diagnose:** table designer > Events (Recent runs) or Admin console > Events run log.
- **Resolve:** guard with `If(...)`.
- **Prevent:** Test run in the designer.
- **Sev / min / gap:** S4 · 15 · none.

### FRM-08 `a; b; c` chaining fails in a data property
- **Customer says:** "Semicolon se error."
- **Likely cause:** `;` chaining works only in action properties (OnSelect, OnSuccess ...).
- **Diagnose:** formula bar message.
- **Resolve:** move the logic to an action property.
- **Prevent:** none.
- **Sev / min / gap:** S4 · 5 · none.

### FRM-09 The user lands on "Done" although the save was refused
- **Customer says:** "Done page dikha par data save nahi hua."
- **Likely cause:** the `Patch(...); Navigate(Done)` caveat: Navigate runs immediately, before the server answers; a refused write (permissions, validation) is rolled back on screen after.
- **Diagnose:** the app's OnSelect.
- **Resolve:** use a **Form** and put `Navigate(Done)` in **OnSuccess**, the message in **OnFailure** ([Security for makers](../../guide/maker/security-for-makers.md#the-navigate-after-patch-caveat)).
- **Prevent:** maker training.
- **Sev / min / gap:** S3 · 20 · none.

## 7. Apps and UI components

### APP-01 "Update available" button appears
- **Customer says:** "Top-right mein Update available aa raha."
- **Likely cause:** a maker saved a newer version of the app while it was open.
- **Diagnose:** none.
- **Resolve:** press it; the new version loads and keeps what was entered.
- **Prevent:** makers edit in Sandbox, deploy in a quiet moment.
- **Sev / min / gap:** S4 · 5 · none.

### APP-02 "Open in new window" opens a tab instead
- **Customer says:** "Naya window nahi khulta."
- **Likely cause:** the browser blocks pop-ups; the app opens as a tab and the portal says so.
- **Diagnose:** the message "The browser blocked the new window, so the app opened as a tab. Allow pop-ups for this site to use new windows."
- **Resolve:** allow pop-ups for the Appbuilder address.
- **Prevent:** group policy for the office browser.
- **Sev / min / gap:** S4 · 5 · none.

### APP-03 The list shows internal columns (id, createdOn ...)
- **Customer says:** "Extra columns dikh rahe hain."
- **Likely cause:** a table UI component with an empty **Columns** property shows every column including system ones.
- **Diagnose:** Studio > the component > Columns.
- **Resolve:** set Columns.
- **Prevent:** checklist item for makers.
- **Sev / min / gap:** S4 · 5 · none.

### APP-04 A dialog does not close
- **Customer says:** "Dialog band nahi hota."
- **Likely cause:** the close button and Esc only run **OnClose**; the maker must set the variable (`Set(showDlg, false)`).
- **Diagnose:** Dialog's Open and OnClose.
- **Resolve:** see the studio pattern.
- **Prevent:** template.
- **Sev / min / gap:** S4 · 10 · none.

### APP-05 "Will the app work on phones?" / the layout is wrong on a phone
- **Customer says:** "Phone par app theek nahi dikhta."
- **Likely cause:** the docs describe phone and tablet **design sizes** (for example 360x800) and a Responsive/Fit scale mode, and the guide says a portrait app fills a phone. The BRIEF lists **phone layouts as planned, not built**. Treat the guide's description as what exists today: one fixed design size per app, scaled, no separate phone layout per screen. **Verify in the product** before promising anything. Changing the size keeps UI components where they are (anchors need a check).
- **Diagnose:** App settings > Design size and Scale mode; test on the actual phone; note that supervisors logging from a phone is the P2 exit check.
- **Resolve:** design a separate app at phone size, test in a real phone browser; set expectations (macro 30).
- **Prevent:** do not sell phone use until P2 ships.
- **Sev / min / gap:** S4 · 20 · **gap: phone layouts (P2 Reach)**; doc contradiction with BRIEF (README feedback).

### APP-06 Studio changes are not saved / "Not saved"
- **Customer says:** "Maine change kiya par wapas purana aa gaya."
- **Likely cause:** the save state shows Saved, Saving, Unsaved or Not saved (autosave about 0.7 seconds after the last edit); the server refused (locked environment, no connection); without a live connection the soft lock cannot tell who else edits and the last save wins.
- **Diagnose:** the status next to the name; "Live updates paused" (LIV-02); environment lock.
- **Resolve:** fix the connection; reload; **Export package** as a safety copy.
- **Prevent:** one editor per app.
- **Sev / min / gap:** S3 · 20 · none.

### APP-07 Blank screen or runtime error in a running app
- **Customer says:** "App chalte hi error."
- **Likely cause:** a formula error (see group 6), a refused data call, or a table or column removed.
- **Diagnose:** Studio > Preview > Debug console (Trace and runtime errors) and the status bar error list (Data warnings, Formulas, Runtime); Server logs for the request.
- **Resolve:** fix the formula or the data source.
- **Prevent:** run Test as user in Preview as a restricted user, not only as admin.
- **Sev / min / gap:** S3 · 30 · none.

### APP-08 Open apps lose their state after reload
- **Customer says:** "Tab reload ke baad data typed gaya."
- **Likely cause:** open tabs come back after a reload but app state starts fresh (variables, typed values).
- **Diagnose:** none.
- **Resolve:** save before reloading; explain.
- **Prevent:** none.
- **Sev / min / gap:** S4 · 5 · none.

### APP-09 A person picker does not offer someone
- See [SEC-14](#sec-14-person-pickers-mentions-and-share-lists-are-empty-or-missing-people).

### APP-10 Attachments: "You may not have access to this file" / "Unavailable"
- **Customer says:** "File dikhti nahi."
- **Likely cause:** the viewer's role cannot open the record or column, or the file is missing (an attachment deleted during a backup window is reported missing in the manifest); a restore without the workspace files.
- **Diagnose:** Who can see a row?; Usage (attachments size); Admin console > Backups manifest.
- **Resolve:** grant access, or restore the file from a backup.
- **Prevent:** off-site backups include attachments (they do: install backups hold attachments and data files).
- **Sev / min / gap:** S3 · 20 · none.

## 8. Validation, rollups and events

### VAL-01 "It will not let me save" (a message under the field)
- **Customer says:** "Save nahi ho raha, red message hai."
- **Likely cause:** a **validation rule** (table logic) or a required/format check in the form ("<name> is required", "Enter a valid email address", "Enter a whole number", "Pick one of the listed choices"); server rules apply to every app, import and API.
- **Diagnose:** the message and the field; Tables > the table > Validation rules (Test run); Events run log lists saves refused.
- **Resolve:** correct the value; if the rule is wrong the maker changes the rule or message.
- **Prevent:** makers write messages in the operator's words.
- **Sev / min / gap:** S4 · 10 · none.

### VAL-02 A rule blocks legitimate entries
- **Customer says:** "Rule galat block kar raha."
- **Likely cause:** formula logic, `Old.`/`New.` confusion, or a `Filter` inside the rule needing `New.Customer`.
- **Diagnose:** the rule's **Test run** on the failing row; Events run log.
- **Resolve:** correct the formula.
- **Prevent:** Test run with edge rows.
- **Sev / min / gap:** S3 · 20 · none.

### VAL-03 A rollup total is late or wrong
- **Customer says:** "Invoice total update nahi hua."
- **Likely cause:** rollups update **a moment after** a related row changes (jobs); an hourly reconcile repairs anything; both tables must be in the default database; a stalled job queue.
- **Diagnose:** Admin console > Jobs (Waiting, Oldest waiting, Failures, Dead); Events run log; Server logs for errors; `rollup.reconcile` schedule.
- **Resolve:** wait a minute; **Run now** the Rollup reconcile schedule (Jobs > Schedules); retry dead jobs.
- **Prevent:** none.
- **Sev / min / gap:** S3 · 20 · none.

### VAL-04 An after-save event did not happen (email not sent, row not created)
- **Customer says:** "Order approve hua par delivery nahi bani."
- **Likely cause:** after-save events run in the background; a failure is retried and the save stays; jobs that fail on input die at once; the condition was false; chain stopped (VAL-05); jobs off (`APPBUILDER_JOBS=off`).
- **Diagnose:** Events run log (filter by table and status); Jobs (failed, dead: **Retry**); Server logs by request id.
- **Resolve:** fix the cause; **Retry** the job.
- **Prevent:** maker tests with Test run.
- **Sev / min / gap:** S3 · 30 · none.

### VAL-05 "Skipped because events kept triggering each other"
- **Customer says:** "Event chal hi nahi raha."
- **Likely cause:** events triggering events deeper than 8 (`APPBUILDER_EVENT_MAX_DEPTH`) are stopped and logged as skipped.
- **Diagnose:** Events run log.
- **Resolve:** change the design to avoid loops.
- **Prevent:** none.
- **Sev / min / gap:** S3 · 30 · none.

### VAL-06 Before-save event times out
- **Customer says:** "Save slow, phir error."
- **Likely cause:** the before-save budget is 2,000 ms per row (`APPBUILDER_EVENT_BUDGET_MS`); heavy lookups.
- **Diagnose:** Events run log; table size; Indexed columns used in the event.
- **Resolve:** simplify, index, or make it an after-save event.
- **Prevent:** none.
- **Sev / min / gap:** S3 · 30 · none.

### VAL-07 Restored rows did not fire events or roll up
- **Customer says:** "Restore ke baad totals galat."
- **Likely cause:** table events do not run for restored rows; rollups are repaired by the hourly check.
- **Diagnose:** Jobs; rollup columns.
- **Resolve:** **Run now** Rollup reconcile.
- **Prevent:** mention in the restore runbook.
- **Sev / min / gap:** S3 · 15 · none.

### VAL-08 Formula column recalculates "forever" after a formula change
- **Customer says:** "Formula badla, columns update nahi hue."
- **Likely cause:** every existing row is recalculated in a background job; also **Indexed** builds are jobs.
- **Diagnose:** Jobs > Waiting/Running; Usage (row counts).
- **Resolve:** wait; check for dead jobs.
- **Prevent:** change formulas outside shifts on big tables.
- **Sev / min / gap:** S3 · 15 · none.

## 9. Live updates and conflicts

### LIV-01 "This record was changed by <name>"
- **Customer says:** "Form mein message aaya, Reload ya Keep mine."
- **Likely cause:** someone saved the record while you were editing, or you pressed Save on a record saved meanwhile; the server refuses to overwrite a newer version without asking.
- **Diagnose:** none; ask who else edits it.
- **Resolve:** **Reload** shows their version (your edits are dropped); **Keep mine** makes your next Save replace theirs; copy your typed values first if unsure.
- **Prevent:** agree who edits a record; help-centre page [changed-by-someone.md](../../help/changed-by-someone.md).
- **Sev / min / gap:** S4 · 5 · none.

### LIV-02 "Live updates paused" in the top bar
- **Customer says:** "Live updates paused likha aa raha, screen late refresh hoti hai."
- **Likely cause:** the live connection (WebSocket `/api/v1/live`) is not available, usually a proxy or firewall that does not pass WebSocket upgrades or cuts idle connections; pages then refresh every 30 seconds.
- **Diagnose:** browser developer tools > Network: a WebSocket `/api/v1/live` with status 101; with Caddy from the installer it works by default; own nginx needs the upgrade headers ([Behind a reverse proxy](../../admin/installation.md#behind-a-reverse-proxy)); ask about antivirus web filters.
- **Resolve:** fix the proxy; meanwhile data still works.
- **Prevent:** use the installer's HTTPS option instead of a custom proxy.
- **Sev / min / gap:** S3 · 30 · none.

### LIV-03 Someone's avatar shows on my app (presence)
- **Customer says:** "Mere app par kisi ka avatar kyun?"
- **Likely cause:** running apps show who else has the same app open; people can hide their presence in Settings > Notifications.
- **Diagnose:** none.
- **Resolve:** explain.
- **Prevent:** none.
- **Sev / min / gap:** S4 · 5 · none.

### LIV-04 Many tabs: new tabs stop updating
- **Customer says:** "Kuch tabs live nahi ho rahe."
- **Likely cause:** at most 20 live connections per user by default (one per open tab, all devices together; `APPBUILDER_LIVE_MAX_PER_USER`); the server's close code 4429.
- **Diagnose:** count tabs; Usage "people online".
- **Resolve:** close unused tabs.
- **Prevent:** none.
- **Sev / min / gap:** S4 · 10 · verify what the user sees (not documented).

### LIV-05 Two screens show different numbers
- **Customer says:** "Do PC par alag count."
- **Likely cause:** one has paused live updates (LIV-02), or sees different rows by role (SEC), or a rollup is catching up (VAL-03).
- **Diagnose:** the three causes in turn.
- **Resolve:** per cause.
- **Prevent:** none.
- **Sev / min / gap:** S3 · 15 · none.

## 10. Notifications and email delivery

### NOT-01 "I get no bell notifications"
- **Customer says:** "Notification aate hi nahi."
- **Likely cause:** In the app is off for that kind in Settings > Notifications; Do not disturb; live connection paused (they appear next time the page opens); the sender used a person who cannot enter the environment ("There is no user ...").
- **Diagnose:** Settings > Notifications > **Why did I get this?** > Show recent deliveries.
- **Resolve:** change the setting; fix the sender's formula.
- **Prevent:** none.
- **Sev / min / gap:** S3 · 15 · none.

### NOT-02 "I do not get emails for notifications / too many emails"
- **Customer says:** "Mail nahi aata" / "Din bhar mail aate hain."
- **Likely cause:** Email setting is **No email**, **Right away** or **In a digest** per kind; **quiet hours hold emails** (default on); more than 20 immediate emails in an hour are collected; a locked kind set by the administrator; the address is on the **suppression list**; relay failing.
- **Diagnose:** Settings > Notifications > Why did I get this? (the reason per delivery, for example "More than 20 emails reached you within an hour, so this one was collected"); Admin console > Email > delivery log and suppression list.
- **Resolve:** adjust settings; remove from suppression; fix relay.
- **Prevent:** default digests for chatty kinds.
- **Sev / min / gap:** S3 · 15 · none.

### NOT-03 SendNotification fails
- **Customer says:** "Notify bhejte waqt error aata hai."
- **Likely cause:** the user is not someone who may open this environment; limits are 30 a minute and 300 an hour per sender; the link must start with `#`.
- **Diagnose:** the message shown to the maker.
- **Resolve:** correct the user/address; reduce volume.
- **Prevent:** none.
- **Sev / min / gap:** S4 · 10 · none.

### NOT-04 Notification link opens the wrong place / the wrong environment
- **Customer says:** "Email ka button kuch aur khol raha."
- **Likely cause:** the link in the notification is wrong (`#u-<app id>`, `#u-tasks`, `?record=<id>`); the email's **Open in Appbuilder** uses the **Public address** which may be `localhost` or an old name.
- **Diagnose:** Admin console > Email > Public address; the maker's link.
- **Resolve:** correct them.
- **Prevent:** test email at onboarding using the real address.
- **Sev / min / gap:** S3 · 15 · none.

### NOT-05 The email relay test fails
- **Customer says:** "Send test email fail ho raha."
- **Likely cause:** wrong host/port/security (STARTTLS 587, TLS 465, None only for a local relay), wrong password, refused sender (from address the relay may not send as), certificate not trusted (internal relay with self-signed: turn off "Verify the relay's certificate"), or the provider requires OAuth which Appbuilder does not support (**XOAUTH2 not supported**: use an app password or relay account); only AUTH PLAIN or LOGIN.
- **Diagnose:** the relay's answer shown after Send test email; the delivery log's last error; the customer's mail provider settings (outside our scope).
- **Resolve:** fix per message; for providers that disable password sign-in for SMTP, use a relay or an app password (**verify the provider's current rule**).
- **Prevent:** decide the relay at pre-sale.
- **Sev / min / gap:** S2 (no reset emails) · 30 · gap: XOAUTH2 for Microsoft 365 and Google (not scheduled; verify).

### NOT-06 Emails show "retrying" or "failed" in the delivery log
- **Customer says:** "Mail queue mein atke hain."
- **Likely cause:** a temporary relay failure (6 attempts with backoff up to 10 minutes) or a permanent refusal (5xx, not retried); jobs off.
- **Diagnose:** the delivery log's last error; Jobs type `mail.send`; Server logs.
- **Resolve:** fix the relay; **Retry** jobs where applicable.
- **Prevent:** none.
- **Sev / min / gap:** S2 · 30 · none.

### NOT-07 Emails go to spam
- **Customer says:** "Mail spam mein jaata hai."
- **Likely cause:** Appbuilder does not sign mail (the relay does DKIM); sender domain/relay lacks SPF/DKIM/DMARC; the "from" address is not the relay's own domain.
- **Diagnose:** headers of a received mail (the customer's mail admin).
- **Resolve:** the mail provider's domain setup (their IT).
- **Prevent:** use the customer's own mail provider relay.
- **Sev / min / gap:** S3 · 20 · none (outside the product).

### NOT-08 Email limit reached
- **Customer says:** "Bahut saare mail fail, limit error."
- **Likely cause:** per environment limits (default 200 recipients an hour and 1,000 a day over all Email connections; `APPBUILDER_EMAIL_PER_HOUR`/`PER_DAY`); a flow's email fails with a retryable "limit" error.
- **Diagnose:** Connections > Activity; delivery log.
- **Resolve:** reduce volume, digests, raise the variable (restart).
- **Prevent:** sizing before sending bulk.
- **Sev / min / gap:** S3 · 20 · none.

### NOT-09 A bounced address keeps getting mail
- **Customer says:** "Purane address par mail jaati rehti hai."
- **Likely cause:** bounces are **not** detected automatically (Appbuilder does not receive mail); the suppression list is manual.
- **Diagnose:** the relay's bounce reports.
- **Resolve:** add the address to the suppression list (password resets and invitations still go).
- **Prevent:** none.
- **Sev / min / gap:** S4 · 10 · gap: no bounce handling (not scheduled).

### NOT-10 Nothing sends at all, and Jobs are "Waiting"
- **Customer says:** "Koi email, report ya event nahi chal raha."
- **Likely cause:** the job worker is not running: `APPBUILDER_JOBS=off`, or the server is stopped/busy; Jobs > Oldest waiting grows; health shows the job queue warning when a due job waited more than 10 minutes.
- **Diagnose:** Admin console > Jobs; Server logs > health: job queue; the service environment file.
- **Resolve:** set jobs on and restart; check the server is healthy.
- **Prevent:** do not change environment variables without a ticket.
- **Sev / min / gap:** S2 · 30 · none.

### NOT-11 "Unsubscribed" accidentally
- **Customer says:** "Maine unsubscribe dabaya, ab wapas chahiye."
- **Likely cause:** the email's one-click link stops emails of that kind without signing in.
- **Diagnose:** Settings > Notifications for the kind.
- **Resolve:** set Email back to Right away or Digest; for a report: re-subscribe on Scheduled reports.
- **Prevent:** none.
- **Sev / min / gap:** S4 · 5 · none.

## 11. Scheduled reports

### RPT-01 "The report did not arrive this morning"
- **Customer says:** "Subah ki report nahi aayi."
- **Likely cause:** the report is **paused**; schedule time/time zone (defaults to the creator's browser time zone); the server was off at that time (a missed slot runs once when the server is back: verify for reports); relay failing (NOT-05/06); the recipient cannot read the table (history says why); **no rows** and "send nothing" (default); the address is on the suppression list.
- **Diagnose:** Scheduled reports > the report > **History**: each run and what happened per recipient (sent, skipped and why); Email delivery log; Jobs.
- **Resolve:** per finding; **Send now** to test.
- **Prevent:** "when there are no rows: send anyway" for reports people expect daily.
- **Sev / min / gap:** S3 · 20 · none.

### RPT-02 Different recipients get different data
- **Customer says:** "Manager ko poora data, mujhe aadha."
- **Likely cause:** every recipient gets what their **own access** allows; an administrator can choose Run as a service account (everyone gets the same, including rows they could not open; audited).
- **Diagnose:** the report's Run as; Test as user.
- **Resolve:** explain; change Run as only after the data owner agrees.
- **Prevent:** decide at design.
- **Sev / min / gap:** S3 · 15 · none.

### RPT-03 CSV has only 5,000 rows
- **Customer says:** "CSV mein sab rows nahi."
- **Likely cause:** reports send the first rows in the body and up to 5,000 in the CSV.
- **Diagnose:** History.
- **Resolve:** narrow the filter or group with totals; for a full copy use the admin's Export data (CSV ZIP) or a backup.
- **Prevent:** none.
- **Sev / min / gap:** S4 · 10 · gap: no larger or PDF output (PDF P2).

### RPT-04 Formula report: "Reads must be delegable"
- **Customer says:** "Report ka formula reject ho gaya."
- **Likely cause:** formula reports must be answerable as a database query (same rule as table events).
- **Diagnose:** the editor's message.
- **Resolve:** rewrite (FRM-01).
- **Prevent:** use the table builder.
- **Sev / min / gap:** S4 · 20 · none.

### RPT-05 A leaver or an owner who left: reports stop
- **Customer says:** "Pehle wale ki report band ho gayi."
- **Likely cause:** reports belong to an owner; a disabled owner (verify what happens to schedules); recipients who left get nothing.
- **Diagnose:** the reports list; History.
- **Resolve:** recreate under a live owner (verify whether ownership can be transferred).
- **Prevent:** reports owned by a shared maker account? (not recommended: one account per person); document an owner.
- **Sev / min / gap:** S3 · 20 · verify.

### RPT-06 Excel shows a leading apostrophe in the CSV
- **Customer says:** "Cell mein ' laga hua hai."
- **Likely cause:** values starting with `=`, `+`, `-`, `@` get a leading `'` so a spreadsheet does not run them as formulas.
- **Diagnose:** the cell.
- **Resolve:** explain (a safety feature).
- **Prevent:** none.
- **Sev / min / gap:** S4 · 5 · none.

### RPT-07 "Can the report be a PDF with our logo?"
- **Customer says:** "PDF report chahiye."
- **Likely cause:** PDF output is planned, not built (P2 Reach; the master plan's exit check is a daily OEE PDF).
- **Diagnose:** none.
- **Resolve:** macro 30; offer the CSV and an HTML email body today.
- **Prevent:** say so in the demo.
- **Sev / min / gap:** S4 · 5 · **gap: PDF (P2)**.

## 12. Backup, restore and disaster

### BKP-01 The Backups page shows amber ("last backup is old / failed")
- **Customer says:** "Admin console mein amber warning hai."
- **Likely cause:** the last good install backup is older than the warning threshold (36 hours by default), or failed; the machine was off at 02:00 (the missed slot runs once at start); disk full; backup folder missing.
- **Diagnose:** Backups list: status, reason; Jobs (backups run as jobs, one at a time); Server logs > health "backups".
- **Resolve:** **Back up now**; fix the cause.
- **Prevent:** monthly health check; off-site copy.
- **Sev / min / gap:** S2 if more than a day · 30 · none.

### BKP-02 A backup is "Failed"
- **Customer says:** "Backup fail dikha raha."
- **Likely cause:** disk full, the backup folder not writable or not found, the post-write **check failed** (rows counted again against the manifest), `pg_dump` not usable when the method is "pg_dump only", PostgreSQL client tools missing.
- **Diagnose:** the reason on the entry; Server logs; disk space.
- **Resolve:** free space; set Settings > Method to Automatic (built-in exporter works without pg_dump); try Back up now.
- **Prevent:** keep disk free; second disk.
- **Sev / min / gap:** S2 · 30 · none.

### BKP-03 "Backups are on the same disk" (no off-site copy)
- **Customer says:** "We think we are backed up."
- **Likely cause:** default backup folder is on the same machine; the off-site folder is not set; a disk failure, fire or ransomware loses both.
- **Diagnose:** Backups > Settings: backup folder and off-site folder.
- **Resolve:** set a second disk, an off-site folder (NAS, USB, cloud-sync), or rclone/restic ([Off-site](../../admin/backup-and-restore.md#off-site)); keep the key and passphrase **apart**.
- **Prevent:** onboarding step 6; checked in every health check.
- **Sev / min / gap:** S2 · 45 · none.

### BKP-04 "The passphrase is wrong, or the backup file was changed"
- **Customer says:** "Backup open nahi ho raha."
- **Likely cause:** wrong passphrase (case, keyboard), or a damaged copy. Scheduled backups use the saved passphrase only on the original server.
- **Diagnose:** try the off-site copy; try a different backup; where was the passphrase written?
- **Resolve:** correct passphrase; else another copy. If the passphrase is truly lost, **encrypted backups cannot be opened by anyone**.
- **Prevent:** passphrase in a password manager and a second place.
- **Sev / min / gap:** S1/S2 · 30 · none (AES-256-GCM by design).

### BKP-05 "This backup was made by a newer Appbuilder"
- **Customer says:** "Restore refuse ho raha."
- **Likely cause:** the installed release is older than the backup's.
- **Diagnose:** `appbuilder version` vs the manifest.
- **Resolve:** update to that version or newer, then restore.
- **Prevent:** keep versions aligned across machines.
- **Sev / min / gap:** S2 · 20 · none.

### BKP-06 "The PC died; restore on a new PC"
- **Customer says:** "Server PC kharab, naya PC hai."
- **Likely cause:** hardware loss.
- **Diagnose:** do they have an `.abbak` (off-site), the passphrase and `.secret-key`?
- **Resolve:** [runbook 3](runbooks.md#runbook-3-restore-from-backup-onto-a-new-pc).
- **Prevent:** drill once a year.
- **Sev / min / gap:** S1 · 180 · gap: the restore path is tested on Linux, **not on Windows** ([Disaster recovery](../../admin/disaster-recovery.md)).

### BKP-07 Lost `.secret-key` (backup has no key)
- **Customer says:** "Key file kho gayi."
- **Likely cause:** key file removed or replaced; install backup made without "Include the encryption key".
- **Diagnose:** "The saved database password cannot be decrypted" at start; backups made with the key included?
- **Resolve:** [runbook 4](runbooks.md#runbook-4-lost-encryption-key): data comes back; secrets (connection passwords, mail password, two-step secrets, saved backup passphrase) must be re-entered.
- **Prevent:** key in a password manager and a safe, apart from backups.
- **Sev / min / gap:** S2 · 90 · none.

### BKP-08 Backup passphrase lost
- See BKP-04. No recovery; tell the customer plainly, and make a fresh backup with a known passphrase while the system is alive.
- **Sev / min / gap:** S2 · 20 · none.

### BKP-09 Accidental deletion of rows
- **Customer says:** "100 rows delete ho gaye."
- **Likely cause:** bulk delete, replace import, or an automated event.
- **Diagnose:** audit `row.delete` (count; at most 1,000 ids; **no values**); who and when; the last backup before that time.
- **Resolve:** [runbook 10](runbooks.md#runbook-10-accidental-mass-delete): restore **selected tables as new tables** into the current environment, or the whole backup as a new environment, then copy rows back (events do not run for restored rows).
- **Prevent:** Back up now before bulk operations; restricted Delete privilege.
- **Sev / min / gap:** S1/S2 · 90 · gap: no undo, no soft delete.

### BKP-10 Whole environment deleted
- **Customer says:** "Environment delete ho gaya."
- **Likely cause:** delete with typed name; a backup is taken first when automatic backups are on.
- **Diagnose:** audit `environment.delete`; Backups list for the automatic backup ("restorable later as a new environment").
- **Resolve:** [runbook 11](runbooks.md#runbook-11-environment-deleted-by-mistake).
- **Prevent:** automatic backups on; few install administrators.
- **Sev / min / gap:** S1 · 90 · none.

### BKP-11 After a restore: "nobody can sign in with the old link / invitations gone / connections broken"
- **Customer says:** "Restore ke baad invitations kaam nahi kar rahe."
- **Likely cause:** sessions and pending one-time links are not in backups (everybody signs in again; send invitations and resets again); connection secrets may need entering.
- **Diagnose:** Connections > Test each; Email > send a test.
- **Resolve:** resend; re-enter secrets; make a new backup.
- **Prevent:** the post-restore checklist (DR doc step 3).
- **Sev / min / gap:** S3 · 20 · none.

### BKP-12 "needs pg_restore" / PostgreSQL tools missing
- **Customer says:** "Restore error pg_restore."
- **Likely cause:** the backup was made with `pg_dump` and restore needs the same or newer PostgreSQL client tools on the PATH (or `APPBUILDER_PG_BIN`).
- **Diagnose:** the message; `where pg_restore`.
- **Resolve:** install tools or set the variable.
- **Prevent:** installer puts PostgreSQL's bin in `APPBUILDER_PG_BIN`.
- **Sev / min / gap:** S2 · 20 · none.

### BKP-13 "Restore to 2:32 pm yesterday"
- **Customer says:** "Kal dopahar 2:32 tak ki state chahiye."
- **Likely cause:** backups are snapshots (nightly 02:00 plus any per-environment schedule); there is **no point-in-time recovery** unless PostgreSQL WAL archiving was set up by them.
- **Diagnose:** the backup list; audit log to find what changed.
- **Resolve:** restore the nearest earlier snapshot as a new environment and merge by hand; explain the loss window.
- **Prevent:** hourly environment schedule for busy production; **Back up now** before risky work.
- **Sev / min / gap:** S2 · 60 · gap: no PITR (documented; not scheduled).

### BKP-14 The Restore test failed
- **Customer says:** "Restore test fail ki notification."
- **Likely cause:** the newest good backup did not restore into temporary schemas or row counts differ from the manifest; disk space; a changed environment.
- **Diagnose:** the result on the backup; Server logs.
- **Resolve:** treat as a backup problem: take a new backup, run **Run it now**, send the bundle.
- **Prevent:** keep it on.
- **Sev / min / gap:** S2 · 60 · none.

### BKP-15 Ransomware / the folder is encrypted
- **Customer says:** "Files encrypted ho gayi."
- **Likely cause:** malware on the machine.
- **Diagnose:** do not run anything; isolate the machine; do they have an **off-site** copy not reachable from the server?
- **Resolve:** [runbook 9](runbooks.md#runbook-9-suspected-unauthorised-access) then [runbook 3](runbooks.md#runbook-3-restore-from-backup-onto-a-new-pc) on a clean machine; rotate every secret.
- **Prevent:** off-site copy on a share the server cannot delete (rclone remote with versions/object lock).
- **Sev / min / gap:** S1 · 240 · none.

## 13. Performance

### PRF-01 "Everything is slow"
- **Customer says:** "Sab kuch slow hai."
- **Likely cause:** server resources (the sizing minimums are not a load test of 50 people), a backup/index/job running, disk nearly full, memory, antivirus scanning the PostgreSQL data folder (not in docs: verify), a heavy formula.
- **Diagnose:** Admin console > Server logs > health (database answer time, memory, disk, job queue); Usage (database size, table rows); Jobs (running); the time of day; ask "which screen, since when, how many people".
- **Resolve:** per finding; [runbook 7](runbooks.md#runbook-7-slow-queries-on-a-big-table) for one table.
- **Prevent:** 8 GB RAM and SSD at install; quarterly health check.
- **Sev / min / gap:** S2 · 60 · gap: sizing for 50 users is an estimate, no load test (installation doc).

### PRF-02 "This query took longer than 15 seconds and was stopped"
- **Customer says:** "Query timeout aa raha."
- **Likely cause:** filtering/sorting/searching on a column that is not indexed on a big table; searching text in an unindexed column reads every row.
- **Diagnose:** which screen/formula; table rows (Usage); the column's **Indexed** flag in the table designer.
- **Resolve:** mark the filtered/sorted columns **Indexed** (an index is built as a job); narrow filters.
- **Prevent:** maker training: index what you filter by.
- **Sev / min / gap:** S2 · 45 · none.

### PRF-03 A big gallery or table loads slowly
- **Customer says:** "List khulne mein time lagta hai."
- **Likely cause:** image-heavy gallery, a formula that runs in the browser (yellow label), many columns, no paging, slow device.
- **Diagnose:** the formula bar label; the Studio error list; try another PC.
- **Resolve:** server-run formulas; fewer columns; reduce images.
- **Prevent:** none.
- **Sev / min / gap:** S3 · 30 · none.

### PRF-04 Slow at the start of the shift
- **Customer says:** "Subah 9 baje sab slow."
- **Likely cause:** many people sign in and open apps together (live connections, big first loads); undersized machine; antivirus scanning.
- **Diagnose:** Usage (people online now); health (memory, database answer time) at that time; compare after.
- **Resolve:** more memory; stagger; check disk (SSD).
- **Prevent:** sizing.
- **Sev / min / gap:** S3 · 60 · verify (no load test).

### PRF-05 The job queue grows ("Oldest waiting")
- **Customer says:** "Jobs waiting badh rahe."
- **Likely cause:** a stopped worker, a burst (formula column recalculation, bulk import events), dead jobs piling, the server restarting.
- **Diagnose:** Admin console > Jobs: Waiting, Running, Oldest waiting, Failures, Dead; the worker line (busy slots).
- **Resolve:** wait; retry/cancel; `APPBUILDER_JOBS_CONCURRENCY` (default 8) only on advice.
- **Prevent:** none.
- **Sev / min / gap:** S3 · 30 · none.

### PRF-06 Disk filling up
- **Customer says:** "C: drive full ho raha."
- **Likely cause:** backups accumulating on the same disk (retention keeps 7 daily, 4 weekly, 3 monthly plus manual ones forever), `app.failed`/`app.previous`, logs (about 100 MB at most), attachments, database growth (about 1 GB per million rows).
- **Diagnose:** Usage (sizes of database, workspace, attachments, data files, backups, logs); health (warning below 10 % free, error below 1 GB).
- **Resolve:** [runbook 6](runbooks.md#runbook-6-disk-full).
- **Prevent:** a second disk for backups; quarterly check.
- **Sev / min / gap:** S2 · 45 · none.

### PRF-07 High memory use
- **Customer says:** "Server memory 90 % hai."
- **Likely cause:** PostgreSQL's own cache on the same machine plus Node; low RAM.
- **Diagnose:** health memory; Task Manager; version info in the bundle's `system.json`.
- **Resolve:** more RAM; verify whether a restart helps; **verify with engineering** what normal looks like.
- **Prevent:** 8 GB.
- **Sev / min / gap:** S3 · 30 · verify.

## 14. Licensing and passes (planned)

### LIC-01 "Where do I upload the licence file?"
- **Customer says:** "Licence file kahan upload karni hai?"
- **Likely cause:** **not built**: Admin console > Licences shows only the planned model; this build checks no licence file and limits nothing; upload arrives with P3.
- **Diagnose:** Admin console > Licences page.
- **Resolve:** macro 30; the contract governs until the product enforces.
- **Prevent:** do not mention licence files in the sales process as available.
- **Sev / min / gap:** S4 · 5 · **gap: licence file and passes (P3)**.

### LIC-02 "How many users are we allowed?"
- **Customer says:** "25 user ka band hai, kitne ban sakte hain?"
- **Likely cause:** nothing is enforced; the Licences page previews which pass each active person would need (Full user: builds and administers, today administrators and makers; Operator: everyone else; External: nobody yet).
- **Diagnose:** the Licences page counts.
- **Resolve:** answer from the contract; use the preview to size the band (do not overstate it).
- **Prevent:** none.
- **Sev / min / gap:** S4 · 10 · gap: P3.

### LIC-03 "We bought a new PC; does the licence move?"
- **Customer says:** "New hardware par licence?"
- **Likely cause:** no licence binding exists today; the policy is a commercial decision (not decided).
- **Diagnose:** none.
- **Resolve:** answer from the contract once decided; until then escalate to the owner.
- **Prevent:** decide the rule before the first contract.
- **Sev / min / gap:** S4 · 10 · gap: policy (P3).

### LIC-04 "Can we give suppliers a login?" (External pass)
- **Customer says:** "Supplier ko login dena hai."
- **Likely cause:** external accounts and portal sites are planned (P6); today every account is an internal person.
- **Diagnose:** Licences page: External shows nobody.
- **Resolve:** macro 30; not recommended to give suppliers internal accounts.
- **Prevent:** be explicit in the sales process.
- **Sev / min / gap:** S4 · 5 · gap: P6 external sites.

## 15. Integrations: connectors, webhooks, API keys

### INT-01 An HTTP connection call is blocked
- **Customer says:** "ERP API call block ho rahi."
- **Likely cause:** the call may reach only the **allowed hosts**; private network addresses (localhost, 10.x, 172.16-31.x, 192.168.x) need **Allow private network addresses**; metadata addresses always refused; `APPBUILDER_OUTBOUND_PRIVATE=deny` refuses private addresses for all.
- **Diagnose:** Connections > the connection settings; Details > Activity (outcome, no inputs); the error.
- **Resolve:** set the switch for an on-prem ERP (administrator); keep allowed hosts narrow.
- **Prevent:** list the systems and addresses at onboarding.
- **Sev / min / gap:** S3 · 20 · none.

### INT-02 "Circuit open" on a connection
- **Customer says:** "Connection pause ho gaya."
- **Likely cause:** 5 failures in a row pause calls for 30 seconds (up to 5 minutes).
- **Diagnose:** Details > Actions shows "Circuit open"; Activity shows the failures.
- **Resolve:** fix the target; people with manage can resume calls.
- **Prevent:** none.
- **Sev / min / gap:** S3 · 20 · none.

### INT-03 A webhook call is rejected (401, 409, 413, 415, 429, 503)
- **Customer says:** "Webhook kaam nahi kar raha."
- **Likely cause:** 401 missing/wrong/too old signature (5-minute tolerance, so check the sender's clock); 409 the same signed call again or the flow is off; 413 body over 256 KB (default); 415 unsupported content type; 429 more than 60 calls a minute; 404 wrong address; 503 busy ([Webhooks](../../guide/maker/webhooks.md), [webhook security](../../admin/webhook-security.md)). Flows are in progress: **verify** the whole flow status before supporting.
- **Diagnose:** the HTTP code the sender receives; the flow's runs.
- **Resolve:** per code; rotate if the address leaked.
- **Prevent:** token-only mode only when the sender cannot sign.
- **Sev / min / gap:** S3 · 30 · none (flows in progress, P1).

### INT-04 "I lost the webhook address / secret"
- **Customer says:** "Webhook ka address bhool gaye."
- **Likely cause:** shown once; the list never shows token or secret. Creation is through the **API** in this version (the designer will show the same panel).
- **Diagnose:** none.
- **Resolve:** **Rotate** (`POST /api/v1/webhooks/<id>/rotate`) and give the sender the new one. Needs API use by a maker: we do this on a call.
- **Prevent:** store it in their password manager at creation.
- **Sev / min / gap:** S3 · 20 · gap: no UI for webhooks (P1).

### INT-05 API key rejected (401/403)
- **Customer says:** "API key se data nahi aa raha."
- **Likely cause:** key revoked or expired; address not allowed (key's IP list); wrong environment (the key works only in its account's environment); endpoint not allowed (only the Data API: query, data, attachments, reading tables, session; everything else 403); rate limit (default 600 a minute); the account's roles do not allow it; format `abk_<8>_<43>`.
- **Diagnose:** Sign-in and security > sign-in log reasons (Unknown API key, Revoked API key, Expired API key, Address not allowed); Service accounts > the key's last used.
- **Resolve:** create a new key (re-authentication needed; shown once), adjust roles.
- **Prevent:** expiry and allowed addresses set at creation.
- **Sev / min / gap:** S3 · 20 · none.

### INT-06 PostgreSQL / MySQL connection test fails
- **Customer says:** "Database connection fail."
- **Likely cause:** one of the documented messages: connection refused, host not found, timeout, access denied, `pg_hba.conf` has no line, database missing, SSL required/unsupported, certificate not verifiable, MySQL 8 authentication plugin, "too many connections".
- **Diagnose:** Connections > Test and the message vs [Connections: What the messages mean](../../admin/connections.md#what-the-messages-mean).
- **Resolve:** per message (their DBA).
- **Prevent:** a read-only role for the connection where possible.
- **Sev / min / gap:** S3 · 30 · none.

### INT-07 "Connect to Tally"
- **Customer says:** "Tally se data sync karna hai."
- **Likely cause:** Tally and ERPNext connectors are planned (P3). Today: CSV/Excel import into a table, an **HTTP connection** to a Tally add-on that exposes an API, or a webhook from a Tally add-on that sends vouchers (the webhooks doc mentions a Tally add-on as an example sender; flows are in progress).
- **Diagnose:** what the customer has (TallyPrime version, any add-on).
- **Resolve:** macro 30; propose CSV exchange for the pilot.
- **Prevent:** do not promise a Tally integration for the pilot unless built.
- **Sev / min / gap:** S4 · 20 · **gap: Tally connector (P3)**.

### INT-08 Connection secrets are blank after a restore or move
- **Customer says:** "Restore ke baad saare connections error."
- **Likely cause:** the key was not restored with the data (BKP-07), or connections were copied to a new environment (they lose passwords).
- **Diagnose:** Connections > Test.
- **Resolve:** enter the secrets again.
- **Prevent:** keep a list of secret holders.
- **Sev / min / gap:** S3 · 30 · none.

## 16. Browser, network, LAN, HTTPS

### NET-01 Browser warning on other PCs ("not secure" / certificate error)
- **Customer says:** "Doosre PC par certificate warning."
- **Likely cause:** with `-Https Lan`, Caddy issues certificates from its own certificate authority; every other PC must trust it once (`appbuilder-local-ca.crt`); Firefox uses its own store unless enterprise roots are on.
- **Diagnose:** which browser; whether the file was imported to the **LocalMachine\Root** store; the fingerprint.
- **Resolve:** import on each PC (Group Policy for many); compare the fingerprint before trusting ([Trust the local certificate](../../admin/installation.md#trust-the-local-certificate)).
- **Prevent:** distribute the certificate at onboarding.
- **Sev / min / gap:** S3 · 30 · none (not run on real Windows).

### NET-02 Other PCs cannot reach `https://<server name>/`
- **Customer says:** "Server PC par chalta hai, baaki PC par nahi."
- **Likely cause:** HTTPS option not chosen (Appbuilder listens on 127.0.0.1 only by design); firewall rule only with `-OpenFirewall` and, on Windows, only for the local subnet on **Domain and Private** profiles (a network marked Public gets no rule); name does not resolve; names in `-LanNames` do not include the one used; the IP changed (DHCP).
- **Diagnose:** `Get-Service Appbuilder-Caddy`; firewall rule; the address typed; `ping` the server name from a client; the Caddy log (`C:\ProgramData\Appbuilder\logs\Appbuilder-Caddy.*.log`).
- **Resolve:** re-run the installer with `-Https Lan -OpenFirewall` and `-LanNames name1,192.168.x.y`; give the server a fixed IP.
- **Prevent:** fixed IP and DNS name at onboarding.
- **Sev / min / gap:** S2 · 45 · none.

### NET-03 Blank page or "forbidden" through our own reverse proxy
- **Customer says:** "Hamare proxy ke through page nahi khulta."
- **Likely cause:** the proxy must keep `Host` and `Origin`, pass WebSocket on `/api/v1/live`, and its name must be in `APPBUILDER_ALLOWED_HOSTS`; set `APPBUILDER_TRUST_PROXY=1` or `APPBUILDER_SECURE_COOKIE=1`.
- **Diagnose:** the browser console/network; the environment file.
- **Resolve:** per [Behind a reverse proxy](../../admin/installation.md#behind-a-reverse-proxy).
- **Prevent:** use the installer's Caddy.
- **Sev / min / gap:** S2 · 60 · none.

### NET-04 Sign-in loops (page reloads to the sign-in)
- **Customer says:** "Login ke baad phir login page."
- **Likely cause:** `APPBUILDER_SECURE_COOKIE=1` while users reach it over plain HTTP (the cookie is never sent); or cookies blocked; or the clock.
- **Diagnose:** address starts `http://`?; the environment file.
- **Resolve:** use the HTTPS address, or unset the variable if HTTP is only on the server itself.
- **Prevent:** none.
- **Sev / min / gap:** S3 · 20 · none.

### NET-05 Works by IP, not by name (or the other way round)
- **Customer says:** "IP se khulta hai, naam se nahi."
- **Likely cause:** the Caddy certificate and allowed hosts cover the names it was installed with (computer name, DNS name, IPv4 addresses by default).
- **Diagnose:** `install.json`; `-LanNames` used.
- **Resolve:** re-run the installer with the full list of names.
- **Prevent:** decide names first.
- **Sev / min / gap:** S3 · 30 · none.

### NET-06 Domain HTTPS: the certificate is not issued
- **Customer says:** "Let's Encrypt certificate nahi mil raha."
- **Likely cause:** the domain's DNS does not point at the server, ports 80/443 not open to the internet (80 is needed to obtain and renew), rate limits.
- **Diagnose:** `journalctl -u caddy` or the Caddy log.
- **Resolve:** fix DNS/ports. Internet exposure is supported only with the hardening checklist; prefer a VPN.
- **Prevent:** do not expose to the internet in the pilot.
- **Sev / min / gap:** S3 · 45 · none.

### NET-07 Which browsers are supported? An old browser misbehaves
- **Customer says:** "Purane Chrome/Edge mein problem."
- **Likely cause:** unknown: the docs do not list supported browsers or versions.
- **Diagnose:** browser and version; developer console.
- **Resolve:** update the browser; **verify with engineering** the supported list.
- **Prevent:** publish a supported-browsers list.
- **Sev / min / gap:** S3 · 20 · **doc gap** (README feedback).

### NET-08 Remote workers, VPN and mobile data
- **Customer says:** "Ghar se kaise chalayein?"
- **Likely cause:** by design the server is on the office machine; internet exposure is supported only through `-Https Domain` with hardening; a VPN is preferred.
- **Diagnose:** the customer's network.
- **Resolve:** VPN to the office network, or the domain option after the hardening checklist and two-step verification for administrators.
- **Prevent:** pre-sale question.
- **Sev / min / gap:** S4 · 30 · none.

### NET-09 After a PC rename, IP change or time change the system acts odd
- **Customer says:** "PC ka naam badla, ab warning."
- **Likely cause:** the certificate/allowed names no longer match; a wrong clock breaks codes and schedules (health warns above 5 seconds drift).
- **Diagnose:** health clock; names in `install.json`.
- **Resolve:** re-run the installer with the new names (repair mode); fix time sync.
- **Prevent:** change management: tell us before renaming.
- **Sev / min / gap:** S3 · 30 · none.

## 17. Printing and export

### PRT-01 "Print this form / invoice as PDF"
- **Customer says:** "Invoice PDF print chahiye."
- **Likely cause:** PDF and document generation are **planned (P2)**, not built. Browser printing of a screen is possible but layout is not designed for print (**verify**).
- **Diagnose:** none.
- **Resolve:** macro 30; interim: browser print on a purpose-built print screen, or CSV to Excel/Word.
- **Prevent:** be explicit in the demo.
- **Sev / min / gap:** S4 · 10 · **gap: PDF output (P2)**.

### PRT-02 Export of a list to Excel
- **Customer says:** "Excel mein kaise nikalein?"
- **Likely cause:** the table grid has **Export CSV** (Dev mode Tables page, makers); apps do not have an export button unless the maker built one (not in the docs: **verify**); admins have **Export data** (all tables, as a ZIP, no row security, recent sign-in, audited); reports email a CSV.
- **Diagnose:** which role and where.
- **Resolve:** a scheduled report to the person; or Export CSV by a maker.
- **Prevent:** none.
- **Sev / min / gap:** S4 · 10 · gap: export from apps for operators (verify; P2).

### PRT-03 CSV opens garbled in Excel (Hindi names)
- **Customer says:** "Hindi text kharab dikh raha."
- **Likely cause:** CSV is UTF-8; older Excel versions open it as ANSI unless imported with the UTF-8 option (**verify** whether a BOM is written).
- **Diagnose:** open in a text editor; Excel's Data > From Text/CSV.
- **Resolve:** import as UTF-8.
- **Prevent:** a note in the help centre when verified.
- **Sev / min / gap:** S4 · 10 · verify.

### PRT-04 Barcode or QR scanning, label printing
- **Customer says:** "Barcode scan karke entry karni hai."
- **Likely cause:** the docs list no barcode/QR scanner or label printing component (**verify** against the UI components reference); a USB scanner acting as a keyboard types into a text field.
- **Diagnose:** the UI components reference.
- **Resolve:** a keyboard-style scanner into a text input; no label printing.
- **Prevent:** pre-sale check of shop-floor needs.
- **Sev / min / gap:** S4 · 15 · **gap (not planned in the BRIEF)**.

## 18. "How do I..." requests that are really feature gaps

Reply with the macro named (macro 30 "planned, not available yet", 31 "in progress", 32 "logged, no promise", 33 "out of scope").
Never say "soon" without a phase; never promise dates.

### GAP-01 Approvals: "Where is my approval inbox?"
- **Customer says:** "Approval kahan aayenge?"
- **Likely cause:** approvals are **in progress**: the flow engine has an approval step, but the **Approvals** menu entry in User mode is marked Soon (P1).
- **Diagnose:** the User mode left menu (Soon badge).
- **Resolve:** macro 31; interim: a status column and a notification (`SendNotification`) with a link to the record; a Choice column "Approve/Reject" in a form.
- **Prevent:** the BRIEF's wording.
- **Sev / min / gap:** S4 · 10 · **gap: approvals UI (P1, in progress)**.

### GAP-02 Flows: "Can I design automation visually?"
- **Customer says:** "Flow designer kahan hai?"
- **Likely cause:** flows are in progress; today a flow is written as a JSON definition on the Flows page; a visual designer replaces it later.
- **Diagnose:** Dev mode > Flows.
- **Resolve:** macro 31; table events and scheduled reports cover simple needs now.
- **Prevent:** do not sell flows as a finished feature.
- **Sev / min / gap:** S4 · 10 · **gap: designer (P1)**.

### GAP-03 Dashboards and charts
- **Customer says:** "KPI dashboard TV par chahiye."
- **Likely cause:** dashboards are planned (P2); there is a **Chart** and **Sparkline** UI component and labels today, so a maker can build a simple chart screen (**verify** with the UI components reference).
- **Diagnose:** the UI component list.
- **Resolve:** macro 30 for the dashboard builder; a chart screen as interim.
- **Prevent:** demo only what exists.
- **Sev / min / gap:** S4 · 15 · gap: dashboards (P2).

### GAP-04 WhatsApp notifications
- **Customer says:** "WhatsApp par alert chahiye."
- **Likely cause:** WhatsApp is planned (P2); the Notifications settings show WhatsApp as arriving with P2 Reach.
- **Diagnose:** none.
- **Resolve:** macro 30; email or the bell today.
- **Sev / min / gap:** S4 · 5 · gap: P2.

### GAP-05 Single sign-on (Google/Microsoft/AD)
- **Customer says:** "Hamare Microsoft login se sign in?"
- **Likely cause:** not built; email + password with two-step (TOTP or email codes); no directory integration (P3.5).
- **Resolve:** macro 30.
- **Sev / min / gap:** S4 · 5 · gap: P3.5.

### GAP-06 Team chat
- **Customer says:** "Chat kab aayega? Chat dock dikhta hai."
- **Likely cause:** the chat panel exists but chat itself is not built; chat tables exist but nothing writes to them (P3).
- **Resolve:** macro 30.
- **Sev / min / gap:** S4 · 5 · gap: P3.

### GAP-07 Documents, spreadsheet and slide editors, a mail client
- **Customer says:** "Documents edit karne hain."
- **Likely cause:** planned (P5 and later), not built; User mode lists modules with a **Soon** badge.
- **Resolve:** macro 30.
- **Sev / min / gap:** S4 · 5 · gap: P5.

### GAP-08 Supplier / customer portal
- **Customer says:** "Supplier ko status dikhana hai."
- **Likely cause:** external portal sites planned (P6).
- **Resolve:** macro 30; a scheduled report by email to the supplier's address is a workaround only for read-only status (each recipient gets what their access allows: an outside address has no account, so **verify** that reports can go to external addresses at all; the docs say makers add "people and teams").
- **Sev / min / gap:** S4 · 10 · gap: P6.

### GAP-09 Ready-made CRM / ERP / manufacturing templates
- **Customer says:** "Koi template hai manufacturing ke liye?"
- **Likely cause:** the templates marketplace is planned (P2/P3); the **Common business model** solution package (accounts, contacts, products, price lists) exists but is served through the API only.
- **Resolve:** macro 30; we build the first app together in onboarding.
- **Sev / min / gap:** S4 · 10 · gap: templates (P2-P3).

### GAP-10 Hindi (or other language) interface
- **Customer says:** "Operators ke liye Hindi mein chahiye."
- **Likely cause:** the interface is English only; choosing the interface language is not supported; makers can write their own labels and messages in any language (verify fonts).
- **Resolve:** macro 32; makers label forms in Hindi; the help centre can be translated later.
- **Sev / min / gap:** S3 · 10 · **gap: localisation (no phase assigned): ask the owner; important for shop-floor sales**.

### GAP-11 Undo / recycle bin / version history of records
- **Customer says:** "Delete undo kaise karein?"
- **Likely cause:** none exists; backups only; the audit log keeps no values.
- **Resolve:** BKP-09; macro 32.
- **Sev / min / gap:** S3 · 15 · gap: no undo, no row history.

### GAP-12 "Alert me when the server is down"
- **Customer says:** "Server band ho to alert aaye."
- **Likely cause:** not supported: no email on a failed health check; the backup warning is the only notification.
- **Resolve:** point any external uptime checker on the LAN at `GET /api/v1/health` (returns `{"status":"ok"}` or 503); `appbuilder health` in a Windows scheduled task.
- **Sev / min / gap:** S4 · 15 · gap: monitoring alerts (P0 follow-up).

### GAP-13 "Deny this one role" / share with a whole department
- **Customer says:** "Sirf is role ko mana karna hai."
- **Likely cause:** roles only add; no deny; sharing is with people or teams, not departments or roles; no time-limited shares.
- **Resolve:** restructure roles; make a team; macro 32.
- **Sev / min / gap:** S4 · 15 · gap (not scheduled).

### GAP-14 "Our app should work without internet / offline on the shop floor"
- **Customer says:** "Internet na ho to bhi chale."
- **Likely cause:** the server is on their LAN, so the **internet is not required** once installed (only for downloads at install); true offline work on a device without the LAN is not supported and not planned in the BRIEF.
- **Diagnose:** what exactly they mean: internet outage vs LAN outage vs a device away from the LAN.
- **Resolve:** clarify; LAN-only works.
- **Sev / min / gap:** S4 · 10 · none/gap (offline devices not planned).

### GAP-15 "Receive emails into the app" / "reply by email"
- **Customer says:** "Mail se record create ho."
- **Likely cause:** Appbuilder only sends mail (through their relay); it does not receive it (hence no bounce handling); a mail client is planned later.
- **Resolve:** macro 32.
- **Sev / min / gap:** S4 · 5 · gap: planned later (not scheduled).

### GAP-16 Forgotten admin password: "reset from the command line"
- **Customer says:** "Command se password reset karo."
- **Likely cause:** there is no command-line password reset; "Forgot your password?", a reset code from another administrator, or the untested advanced database step ([SIG-11](#sig-11-the-only-administrator-is-locked-out-by-two-step-verification)).
- **Resolve:** a second administrator; runbook 5.
- **Sev / min / gap:** S2 · 60 · **gap: admin recovery path (P0 follow-up)**.

## Case count and top cases

Total cases above: see the count in [README.md](README.md). The fifteen we expect most often in a pilot, in rough order:
SEC-02, SEC-01, SEC-07, SEC-06, SIG-03, SIG-04, SIG-01, NOT-02, RPT-01, FRM-01, LIV-01, BKP-03, NET-01, NET-02, SEC-03.
