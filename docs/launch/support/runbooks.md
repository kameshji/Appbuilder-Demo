# Runbooks for the twelve highest-severity situations

Status: working draft, 19 Nov 2026, for version 0.5.0. Each runbook cites the existing doc section it comes from. A step
that could **not** be confirmed from the docs is marked **VERIFY WITH ENGINEERING**; do not improvise those steps on a
customer's production machine: stop, tell the customer what is unknown, and ask. All Windows commands come from the
admin docs, but the Windows installer and updater have **not yet been run on a real Windows machine** (release process doc),
so every Windows-specific line is "as documented, untested".

Short names: **bundle** = diagnostics bundle (Admin console > Server logs > Diagnostics bundle, or
`& 'C:\Program Files\Appbuilder\appbuilder.cmd' diagnostics --out C:\Temp\bundle.zip`; Linux
`sudo appbuilder diagnostics --out bundle.zip`); **health** = `& 'C:\Program Files\Appbuilder\appbuilder.cmd' health`
(Linux `appbuilder health`; prints `ok`, `starting`, `degraded` or `down`). Message macros are in [macros.md](macros.md).

Contents: [Customer "first thirty minutes"](#the-first-thirty-minutes-card-for-the-customers-administrator) - 1 [Server will not start after an update](#runbook-1-server-will-not-start-after-an-update) -
2 [Database unreachable](#runbook-2-database-unreachable) - 3 [Restore onto a new PC](#runbook-3-restore-from-backup-onto-a-new-pc) -
4 [Lost encryption key](#runbook-4-lost-encryption-key) - 5 [Administrator locked out with two-step verification](#runbook-5-administrator-locked-out-with-two-step-verification) -
6 [Disk full](#runbook-6-disk-full) - 7 [Slow queries on a big table](#runbook-7-slow-queries-on-a-big-table) -
8 [Emails not sending](#runbook-8-emails-not-sending) - 9 [Suspected unauthorised access](#runbook-9-suspected-unauthorised-access) -
10 [Accidental mass delete](#runbook-10-accidental-mass-delete) - 11 [Environment deleted by mistake](#runbook-11-environment-deleted-by-mistake) -
12 [Failed solution upgrade](#runbook-12-failed-solution-upgrade) - [Open questions for engineering](#all-verify-with-engineering-items-in-one-list)

## The first thirty minutes: card for the customer's administrator

Printed in the onboarding pack. In any serious problem, before anything else:

1. **Do not restart the server again and again, and do not delete anything** (not the program folder, not
   `C:\ProgramData\Appbuilder`, not backups, not `app.failed`).
2. Check the **health**: in a browser `https://<server>/api/v1/health` (or `http://localhost:5174/api/v1/health` on the server)
   answers `{"status":"ok"}`, or `starting` / `degraded` (HTTP 503). On the server: `appbuilder health`.
3. Check the **services** (elevated PowerShell): `Get-Service Appbuilder, appbuilder-postgresql, Appbuilder-Caddy`.
4. Check **free disk space** on the server (C: and the backup disk).
5. Make a **diagnostics bundle** (works even when Appbuilder does not start) and email it with: time it started, what was
   done just before, the exact message on the screen.
6. Tell your staff to use the paper fallback. Call {{support number}}.

---

## Runbook 1: Server will not start after an update

**Severity** S1 (production down) or S2 (rolled back and running on the old version). **Source:** [Upgrades](../../admin/upgrades.md)
(update steps, What happens to the database, Roll back), [Troubleshooting](../../guide/troubleshooting.md#server-will-not-start),
[Operations](../../admin/operations.md).

**Ask first:** what did `appbuilder update` print at the end? The exit codes are 0 updated, **2 failed and rolled back**,
3 refused before anything changed. Did the release notes say the database schema changes? What does `health` say now?

**Steps**

1. **Do not run the update again yet.** Note the printed lines. Call the customer's administrator (macro 25 for the message).
2. **Exit code 3 (refused, nothing changed):** read the refusal (downgrade, newer Node.js needed, schema older than the
   database's, server not healthy, signature or checksum). Fix that, not `--force`. A newer Node.js requirement means run
   **that release's installer**, which updates Node.js too.
3. **Exit code 2 (rolled back):** the updater moved the new release to `app.failed` and restarted `app.previous` as `app`.
   Run `health`. If it prints `ok`, users can work on the old version: collect a **bundle** (it includes `release-check.json`,
   `schema.json` and the logs), keep `app.failed`, and stop; engineering finds the cause. Check `appbuilder version` and
   Admin console > Updates (history).
4. **If `health` is not ok**, read the service log: Windows `C:\ProgramData\Appbuilder\logs\Appbuilder.out.log` and `.err.log`
   plus `C:\ProgramData\Appbuilder\workspace\logs\appbuilder.log`; Linux `journalctl -u appbuilder`. Look for one of:

   | Line | Meaning | Action |
   | --- | --- | --- |
   | `DATABASE NOT USED: The database schema is version N, but this Appbuilder only knows version M` | An older release is running against a database a newer release already migrated. The browser shows "This database needs a newer Appbuilder". | Either start the **newer** release again (step 5) or restore the pre-upgrade backup (step 6). Never edit the database by hand. |
   | `DATABASE NOT UPGRADED: the backup before the schema upgrade failed` | The pre-migration install backup failed (disk, backup folder), so the server did not migrate and does not retry. | Fix disk/backup folder ([runbook 6](#runbook-6-disk-full)), restart the service. Only as a last resort and with a manual backup in hand, start once with `APPBUILDER_MIGRATION_BACKUP=skip`. |
   | `ERROR ENVIRONMENT <id> NOT AVAILABLE` | One environment failed to migrate; the others and the server work. | Read the reason in Admin console > Environments; the next start retries; send the bundle. |
   | `The saved database password cannot be decrypted` | `workspace\.secret-key` was replaced. | [Runbook 4](#runbook-4-lost-encryption-key). |
   | `Port N is already in use` | Another program or a second Appbuilder. | Stop the other one. |
   | Nothing, service restarting every few seconds | A crash loop (Windows restarts after 10, 30, 60 seconds and resets after an hour; Linux after 5 seconds). | Collect the bundle (its `service-logs/` hold the last 2 MB of each wrapper log); **VERIFY WITH ENGINEERING** the cause. |

5. **Roll the program folder back by hand** (only valid when the release did **not** change the database schema; release notes
   and `appbuilder version` say): stop the service, rename `app` to `app.failed` and `app.previous` to `app`, start the service
   ([Roll back](../../admin/upgrades.md#roll-back)). Windows (elevated): `Stop-Service Appbuilder`; rename the two folders under
   `C:\Program Files\Appbuilder`; `Start-Service Appbuilder`. **VERIFY WITH ENGINEERING:** what to do if `app.failed` already exists
   (a second failure), and whether permissions need resetting after a manual rename (the updater "sets the permissions").
6. **Restore the pre-migration database backup** (only if the schema already changed and going back is the decision).
   **A restore discards everything written since that backup; a person decides, with the customer in writing.** The updater names the
   backup and the command:
   ```
   sudo systemctl stop appbuilder
   sudo appbuilder restore /var/lib/appbuilder/backups/appbuilder-install-<date>-<id>.abbak --force
   sudo systemctl start appbuilder
   ```
   Windows (elevated): `Stop-Service Appbuilder`, `& 'C:\Program Files\Appbuilder\appbuilder.cmd' restore <file> --force`,
   `Start-Service Appbuilder`. Then step 5 (old program) if needed. Alternatively fix the cause and run the update again: that
   keeps all data (the failure may have nothing to do with the database).
7. **Verify:** `health` is `ok`; sign in; open an app; **Connections > Test** each; Admin console > Server logs has no red
   items; Admin console > Backups still shows the nightly schedule.

**Communicate:** macros 36/37 (outage), 25 (rolled back). **After:** [post-incident review](macros.md#post-incident-review-template);
bug in the updater or release? product fix. **Not confirmed in docs:** behaviour on a real Windows machine.

---

## Runbook 2: Database unreachable

**Severity** S1. **Source:** [Troubleshooting](../../guide/troubleshooting.md#cannot-sign-in) ("The database is not reachable"),
[Operations: Health](../../admin/operations.md#health), [Installation](../../admin/installation.md#first-run-setup) (setup after the
first administrator), [Hardening checklist](../../admin/hardening-checklist.md#before-first-start).

**Meaning of health:** `starting` = no database configured yet, or not reachable for less than two minutes after start;
`degraded` = the database does not answer, is newer than this release, or an environment failed to migrate. The server retries by
itself (up to every 30 seconds) and the browser shows "The database is not reachable" with **Try again**; no Appbuilder restart is
needed once PostgreSQL is back.

**Steps**

1. `health`, then the browser health URL. Note `starting` or `degraded`.
2. **Is PostgreSQL running?** Installer-made install: `Get-Service appbuilder-postgresql` (Windows), `systemctl status postgresql`
   (Linux; **VERIFY** the unit name for the PGDG package). `Start-Service appbuilder-postgresql` if stopped. Note: the troubleshooting
   page names the service `postgresql-x64-17` for installs made another way; on an installer install the service is
   `appbuilder-postgresql` (docs disagree: see README feedback).
3. **Why did it stop?** Disk full is the usual cause ([runbook 6](#runbook-6-disk-full)); then power loss, someone stopping it, memory.
   Ask for the time and what happened. **VERIFY WITH ENGINEERING** where PostgreSQL's own log lives for the installer-made cluster
   (`C:\ProgramData\Appbuilder\pgdata`); the docs do not say. Do **not** delete anything in `pgdata`, and never run `initdb`.
4. **If PostgreSQL runs but Appbuilder cannot log in:** messages in [Connections: PostgreSQL](../../admin/connections.md#postgresql)
   (access denied, no `pg_hba.conf` entry, database missing). The database login is in `workspace\server.json` (password sealed) or in
   `APPBUILDER_DB_*`. If the password changed, re-run the installer: it replaces the role's password "only if the saved one stopped
   working" ([Installation](../../admin/installation.md#install-on-windows)); source installs: `scripts\setup-postgres.ps1`.
5. **If the database is on another machine** (not the installer's normal setup): network, firewall, `pg_hba.conf`, SSL.
6. Once PostgreSQL answers, wait up to 30 seconds, press **Try again**, run `health` until `ok`. If it says `degraded` with a
   schema message go to [runbook 1](#runbook-1-server-will-not-start-after-an-update).
7. **If PostgreSQL will not start or the data folder is damaged:** stop; do not repair by guessing. Make sure the **off-site backup**
   exists, bring in the outside PostgreSQL specialist (support model, escalation level 3), and plan [runbook 3](#runbook-3-restore-from-backup-onto-a-new-pc).
8. **Verify:** health `ok`; sign in; a table loads; Admin console > Server logs > database answer time normal; check last backup
   not older than 36 hours.

**Communicate:** macro 36 then 37. **Prevent:** disk monitoring; services start order (PostgreSQL before Appbuilder, delayed automatic
start). **Not confirmed in docs:** PostgreSQL log location, the Linux service name for PGDG, crash-recovery behaviour after a full disk.

---

## Runbook 3: Restore from backup onto a new PC

**Severity** S1. **Source:** [Disaster recovery](../../admin/disaster-recovery.md) (all sections),
[Backup and restore](../../admin/backup-and-restore.md#restore). The restore command is **tested on Linux, not on Windows**.

**Have ready:** the `.abbak` archive (off-site copy or a download); its **passphrase** if encrypted; the **encryption key**
(`.secret-key` or `APPBUILDER_SECRET_KEY`) unless the backup includes it; written agreement of the customer that restoring
discards everything after the backup's time (state the backup time in the message).

**Steps**

1. **Check the archive first, on any machine with the same or a newer release:** `node server/main.ts restore <archive> --check`
   (source) checks it completely (checksums, row counts) without changing anything; an installed machine runs
   `appbuilder restore <archive> --check` (**VERIFY**: the docs list `--check` for the `node server/main.ts restore` form; confirm it on the
   `appbuilder restore` command). Wrong passphrase gives "The passphrase is wrong, or the backup file was changed"; "damaged or altered" names
   a file: use another copy.
2. **Install the same release or newer on the new PC** (a newer one upgrades the restored database; an older one refuses
   it: "made by a newer Appbuilder"). Use the normal installer ([Installation](../../admin/installation.md)); it creates PostgreSQL,
   the role, the database and starts the service with **empty** Appbuilder schemas. **Do not run the setup screen.** If HTTPS for
   the local network is used, keep the same computer **name and fixed IP** (the certificate names are made at install).
3. **Stop the service and restore over the empty schemas with `--force`:**
   ```
   sudo systemctl stop appbuilder
   sudo appbuilder restore /path/appbuilder-install-<date>-<id>.abbak --force
   sudo systemctl start appbuilder
   ```
   ```powershell
   Stop-Service Appbuilder
   & 'C:\Program Files\Appbuilder\appbuilder.cmd' restore D:\Restore\appbuilder-install-<date>-<id>.abbak --force
   Start-Service Appbuilder
   ```
   Options: `--passphrase-file <file>` (else `APPBUILDER_BACKUP_PASSPHRASE`, else it asks; **never** type it in a shared screen
   or ask the customer to send it), `--key-file <.secret-key kept apart>`, `--check`, `--yes`. It prints each step: check the whole
   archive, restore schema `ab` and every environment in one transaction, write attachments and data files, write the key
   (`--key-file`, else the key in the archive, else a new key is created), write `server.json`, report
   "**Saved secrets that this key cannot decrypt: N of M**", run the migration.
4. **Check** (DR doc, section 3): sign in with an account from the backup (everybody signs in again; sessions are not in
   backups, pending invitations and reset links must be sent again); Admin console > Environments (all present, none Failed); open an
   app or two; a table's row count against the manifest/old count; an attachment; **Connections > Test** each; Admin console > Email >
   send a test.
5. **After the restore:** Admin console > Backups: make a new backup and check the nightly schedule is on; turn the off-site copy back
   on; re-enter any secret the key could not decrypt ([runbook 4](#runbook-4-lost-encryption-key)). With `-Https Lan`, the new machine has a **new
   local certificate authority**, so every client PC must import the new `appbuilder-local-ca.crt` (**VERIFY WITH ENGINEERING**: the docs
   say the CA is made on the server; they do not say it is restored).
6. **Errors:** "needs pg_restore" (install PostgreSQL client tools of the same or newer version, or set `APPBUILDER_PG_BIN`);
   "The database already holds Appbuilder schemas" (pointing at a database in use: use an empty one or `--force` only if you mean it);
   "ENVIRONMENT <id> NOT AVAILABLE" (that environment's migration failed; reason in Admin console > Environments).

**Communicate:** macros 36/37; macro 38 for the data after the backup. **Time:** plan 2 to 3 hours including installation.
**Not confirmed:** the Windows path; time on a typical office PC; local CA handling.

---

## Runbook 4: Lost encryption key

**Severity** S2 (S1 if the server no longer starts). **Source:** [Disaster recovery: Without the encryption key](../../admin/disaster-recovery.md#without-the-encryption-key),
[Backup and restore: What a backup contains](../../admin/backup-and-restore.md#what-a-backup-contains),
[Troubleshooting](../../guide/troubleshooting.md#server-will-not-start), [Installation: workspace folder](../../admin/installation.md#the-workspace-folder).

**What the key protects:** saved secrets (passwords and keys of connections to other systems, the mail server password, two-step
verification secrets, the saved backup passphrase, and the database password in `server.json`). It is `workspace\.secret-key`
(64 hex characters) or `APPBUILDER_SECRET_KEY`. **No one, including us, can recover it.**

**Steps**

1. **Is the server still running?** If it started before the file was lost and has not been restarted, **do not restart it**.
   **VERIFY WITH ENGINEERING** whether Back up now with "Include the encryption key" (Admin console > Backups) works from the running
   process while the file is missing; if so make that backup at once, encrypted with a passphrase, and store it safely.
2. **Look for the key**: password manager, safe, other copy of the workspace, an old backup made with "Include the encryption key",
   the PC's backups, `APPBUILDER_SECRET_KEY` in the service environment (`C:\ProgramData\Appbuilder\config\appbuilder.env`, `/etc/appbuilder/appbuilder.env`).
   Found: put it back as `workspace\.secret-key` (owner-only permissions as before), restart the service, `health`.
3. **Not found, server does not start** ("The saved database password cannot be decrypted"): the data is intact; only secrets are lost.
   Documented recovery: delete `workspace/server.json` and run the database setup again with the setup code from the server window
   ([Troubleshooting](../../guide/troubleshooting.md#server-will-not-start); the manual restore step 6 in
   [Backup and restore](../../admin/backup-and-restore.md#manual-restore)); a **new key** is created; users, roles and apps stay (accounts still
   work because the database already has users). **Installer-made installs:** the database password was random and sealed, so the setup
   screen cannot be completed by a person who does not know it; re-run the installer in repair mode, which replaces the role's password
   when the saved one stopped working. **VERIFY WITH ENGINEERING** that repair mode handles a missing key and seals a new `server.json`
   (the docs describe this only for the password). Take a **manual backup of the database first** with `pg_dump` if there is any doubt
   (Backup and restore, Appendix).
4. **Re-enter every secret that is now unreadable:** each **connection** (Connections > the connection > Edit, enter the password or key,
   then Test; the default database is rebuilt from `server.json`), Admin console > **Email** (relay password), **two-step verification**
   (affected people set up their authenticator again; an administrator resets it: Users > menu > Reset two-step verification), and the saved
   **backup passphrase** (Backups > Settings; old encrypted archives still open with the passphrase itself).
5. **Make a new backup at once** and, this time, store `.secret-key` apart (password manager, safe, two people know where).
6. **If a restore on a new machine is needed and the archive has no key** the same table applies: all data back, secrets re-entered; the
   restore command prints how many secrets it could not decrypt.

**Communicate:** macro 29. **Prevent:** onboarding step 6 and the health-check list. **Not confirmed:** items marked VERIFY.

---

## Runbook 5: Administrator locked out with two-step verification

**Severity** S2, or S1 if production needs an administrator action. **Source:**
[Sign-in and identity](../../admin/sign-in-and-identity.md#two-step-verification) (Lost phone, Confirming it is you),
[Users and roles: Locked out](../../admin/users-and-roles.md#locked-out),
[Signing in: Lost your phone?](../../guide/signing-in.md#lost-your-phone), [Hardening: First run](../../admin/hardening-checklist.md#first-run).

**Honest summary of what the docs provide:** there is a recovery path for **a person while another install administrator exists**
(Users > menu > Reset two-step verification) and for a person with **recovery codes**. There is **no command-line password reset**
and **no documented, tested way to clear two-step verification for the only install administrator**. The docs mention only an
"advanced step ... we have not documented a tested procedure": changing `password_hash` in `ab.users`, which would not remove two-step
verification anyway. Do not attempt database edits on a customer system without engineering and a written request.

**Steps, in order of least risk**

1. **Confirm identity of the requester** by calling the customer's known administrator (not the number in the email).
2. **Is there another install administrator?** Yes: they open Admin console > Users > the person's three-dot menu > **Reset two-step
   verification** (audited as `user.mfa_reset`; signs the person out everywhere); the person signs in with the password and sets it up
   again. If the password is also forgotten: **Create one-time reset code** (macro 8, 10). Done.
3. **Recovery codes?** Sign in with the password, **Use a recovery code** on the second-step screen (macro 9).
4. **Is any browser still signed in** as that administrator (sessions last until 7 days idle or 30 days total by default)? Then in
   Settings > Profile the person can make **New recovery codes** or turn the app off; those actions ask for the **password** (or a code)
   typed within the last 10 minutes. While the policy requires two-step verification the last method cannot be turned off, so new
   recovery codes are the way then. **VERIFY WITH ENGINEERING** that the password alone is accepted for re-authentication when two-step
   verification is on (the docs say "the password, or a code from the authenticator app").
5. **Is the device remembered** ("Remember this device for 30 days")? On that browser the password alone signs in; then step 4.
6. **Email codes turned on?** On the second-step screen choose **Get a code by email** (needs Email set up and the policy "Allow email
   codes").
7. **Nothing works and no other administrator exists.** There is no self-service recovery. Options, all **VERIFY WITH ENGINEERING** first:
   (a) a tested one-off engineering procedure that clears the two-step records of one user and ends their sessions, run on a call with the
   customer's IT under a written access request ([support model, section 10](support-model.md#10-data-access-rules-for-support-staff)), after a
   `pg_dump` backup; (b) restoring a backup made **before** the person enrolled two-step verification (loses everything since, so only for a fresh
   install); (c) a new install and a solution export/import (the data is on the old database, so this needs (a) anyway).
   **Tell the customer plainly that this is a product gap** (README feedback item 1) and agree the time and risk before touching anything.
8. **After:** the person logs in, makes new recovery codes and stores them; create a **second install administrator** now; Admin console >
   Sign-in and security: check the two-step policy is what the customer wants; check `user.mfa_reset` in the audit log.

**Communicate:** macros 10, 9, 8. **Prevent:** second install administrator, codes in a password manager, the lockout test at onboarding
("lock yourself out on purpose in Sandbox on day 3"). **Not confirmed:** steps 4 and 7.

---

## Runbook 6: Disk full

**Severity** S2, S1 if PostgreSQL has stopped. **Source:** [Operations: Health](../../admin/operations.md#health) (disk warning below 10 %
free, error below 1 GB), [Backup and restore](../../admin/backup-and-restore.md#schedules-and-retention) (retention, settings),
[Installation: sizing](../../admin/installation.md#requirements-and-sizing), [Upgrades](../../admin/upgrades.md#what-happens-to-the-database).

**Effects to expect:** backups Failed ("disk full") and a notification to administrators; the pre-migration backup fails and the server
does **not** upgrade the database; PostgreSQL may stop ([runbook 2](#runbook-2-database-unreachable)); attachments cannot be saved;
the log files stop growing.

**Steps**

1. Admin console > **Server logs** > health (disk of the workspace, backup and log folders) and Admin console > **Usage** (sizes of
   the database, workspace folder, attachments, data files, backups, logs). Decide **what grew**.
2. **Safe to free, in this order:**
   - Old **manual** backups the customer confirms they do not need, **after** a good off-site copy exists. Careful: deleting a backup in
     Admin console > Backups **also deletes its off-site copy**. Never delete the newest verified backup or one the customer pinned.
   - Release ZIPs left in `C:\ProgramData\Appbuilder\updates\staged` and old ZIPs in the customer's Downloads; `app.failed` and
     `app.previous` **only after** the incident is closed (they are your rollback).
   - Logs are capped (file log about 100 MB; WinSW logs 8 x 10 MB). Do not delete them: they are needed for diagnosis.
3. **Never delete** anything in `pgdata`, the database folders, `.secret-key`, `server.json`, `env\<id>\attachments`.
4. **Long-term fix:** put the **backup folder on a second disk** (Admin console > Backups > Settings > Backup folder; not available if
   `APPBUILDER_BACKUP_DIR` is set; archives already in the old folder are listed again only if copied into the new one: copy them, the
   docs say archives copied in are found at the next start), or add disk. Sizing: 20 GB plus 3 times the database size, SSD.
   Moving the **PostgreSQL data** folder is **not documented**: **VERIFY WITH ENGINEERING** before advising it.
5. If PostgreSQL stopped: free space first, then `Start-Service appbuilder-postgresql`, then `health`.
6. **Verify:** health disk checks green; **Back up now** succeeds and is **Verified**; the nightly schedule is on; tell the customer
   when they will hit the limit again (growth per month from Usage).

**Communicate:** macros 26, 36. **Prevent:** quarterly health check; second disk; alerts (a product gap: no alert but the backup
warning). **Not confirmed:** PostgreSQL behaviour on a full disk; how to move `pgdata`.

---

## Runbook 7: Slow queries on a big table

**Severity** S2 (a shift cannot work) or S3. **Source:** [Data: Large tables](../../guide/maker/data.md#large-tables-what-runs-on-the-server),
[Troubleshooting: Data warnings](../../guide/troubleshooting.md#data-warnings), [Operations: Usage and Health](../../admin/operations.md#usage),
[Jobs](../../admin/jobs.md).

**Steps**

1. **Which table and which screen, since when, how many people?** Admin console > **Usage**: row count per table (exact up to
   100,000, a PostgreSQL estimate above, marked `~`) and size. Health: database answer time, memory, job queue.
2. **Read the message.** "This query took longer than 15 seconds and was stopped": filtering/sorting/searching a column that is
   not indexed. "Can't run on the server: ...": rewrite the formula ([FRM-01](support-use-cases.md#frm-01-cant-run-on-the-server--red-underline)).
   "This query returns more than 5,000 rows/groups": limit it. "only the first 5,000 rows are searched, sorted and counted": the table is on a
   MySQL, data-file or Google Sheets connection (move it to the default database; Data files > **Move to database**).
3. **Formula bar label** in the Studio (**Runs on server / Runs in browser / Can't run**) for the formula behind the slow screen; the yellow
   label on a growing table is the warning sign. Status bar > error list > Data warnings.
4. **Index what is filtered, sorted or searched:** table designer > the column > **Indexed** (server mode). The index is built by a **job**
   (Admin console > Jobs; watch Running and Waiting; a big table takes time and costs a little on each save). Lookup and unique columns are
   always indexed.
5. **Check security rules:** row rules through lookups and related rows run inside the same SQL statement; a rule with two lookup steps on a large
   table costs more. **VERIFY WITH ENGINEERING** which rule shapes are expensive (not documented).
6. **Check for competing work:** Jobs (a formula-column recalculation or index build running), a backup at 02:00, a scheduled report, a huge import with
   events.
7. **Check capacity:** memory and CPU against the sizing table; antivirus scanning the database folder (**not documented; VERIFY**).
8. **If it is still slow:** with a written access request, ask the customer's DBA or our engineering to run `EXPLAIN` on the query (needs database
   access: [section 10](support-model.md#10-data-access-rules-for-support-staff)); there is no documented PostgreSQL tuning guidance.
9. **Verify:** the same screen with the same user; repeat at the busiest time.

**Communicate:** macro 17 (maker). **Prevent:** quarterly table-size review; maker training on server formulas. **Not confirmed:**
real-world behaviour at 50 concurrent users (no load test), index build time.

---

## Runbook 8: Emails not sending

**Severity** S2 (no password resets or invitations; notifications and reports not arriving). **Source:**
[Sign-in and identity: Email](../../admin/sign-in-and-identity.md#email), [Installation: Set up email](../../admin/installation.md#set-up-email-smtp-relay),
[Connections: Email limits and the suppression list](../../admin/connections.md#email-limits-and-the-suppression-list), [Jobs](../../admin/jobs.md).

**Steps**

1. Admin console > **Email**: press **Send test email**. Read the relay's answer (wrong password, refused sender, certificate, connection).
2. **Delivery log** (same page): recipient, subject, template, status (queued, sent, retrying, failed), attempts and the last error; never the body.
3. **Relay settings:** host, port and security (STARTTLS 587; TLS 465; None only for a relay on this computer), user and password, "from" address the relay may
   send as, **Public address**. Appbuilder signs in with AUTH PLAIN or LOGIN only; **OAuth (XOAUTH2) is not supported**: a provider that requires it needs an app
   password or a relay account (**VERIFY** the provider's current rules with the customer's mail admin).
4. **Is the job worker running?** Every email is a `mail.send` job in the **Default** environment's queue. Admin console > Jobs: Waiting, Oldest waiting, Failures,
   Dead. `APPBUILDER_JOBS=off` means nothing is sent. Health: job queue warning when a due job waited more than 10 minutes.
5. **Temporary failures** are retried 6 times with backoff (2 s doubling, at most 10 minutes); a permanent refusal (5xx) is not retried. After you fix the
   relay, **Retry** failed/dead `mail.send` jobs on the Jobs page (**VERIFY** that this works for the system emails of the Default environment and what happens to
   emails older than their usefulness, e.g. an expired reset link).
6. **Limits and suppression:** per environment 200 recipients an hour and 1,000 a day (`APPBUILDER_EMAIL_PER_HOUR`, `_PER_DAY`); the **suppression list** skips
   flows, notifications and reports (not resets and invitations); bounces are never detected automatically.
7. **Clock:** health warns above 5 seconds drift between server and database; codes and schedules depend on it.
8. **Key lost?** The relay password is sealed with the key: re-enter it ([runbook 4](#runbook-4-lost-encryption-key)).
9. **Interim for people who cannot get in:** one-time reset codes (Users menu), temporary passwords; invitations need email.
10. **Verify:** Send test email arrives; a real "Forgot your password?" reaches a test mailbox; the delivery log shows `sent`; reports and notifications resume.

**Communicate:** macro 21. **Prevent:** a monthly test email; a shared mailbox as the "from" address. **Not confirmed:** retry behaviour after long outages;
the mail log location for failures other than the delivery log.

---

## Runbook 9: Suspected unauthorised access

**Severity** S1 until triaged. **Source:** [Security model](../../admin/security-model.md), [Audit log](../../admin/audit-log.md),
[Sign-in and identity](../../admin/sign-in-and-identity.md) (sessions, policy, API keys, audit entries), [Hardening checklist](../../admin/hardening-checklist.md),
[Webhook security](../../admin/webhook-security.md), [Operations: logs](../../admin/operations.md#logs). We are not a forensic firm and give no legal advice: the customer's
legal reporting duties are theirs to determine with their counsel.

**Triggers:** "New sign-in" email nobody recognises; strange rows/changes; bursts in the sign-in log ("Wrong password", "Too many attempts", "Invalid reset code",
"Unknown API key"); a researcher's report; ransomware; a leaver who still signs in; a leaked password, API key or webhook address.

**Steps**

1. **Do not wipe or reinstall.** Tell the customer to keep the machine on and not delete logs. Ask: what, when, which account, any exposure to the internet (domain mode)?
2. **Preserve evidence first** (read-only): Admin console > Server logs > **download log files** (secrets removed; the file log keeps about 100 MB so older lines roll
   off); the **bundle**; screenshots of Admin console > Sign-in and security > Sign-in log (time, account or typed email, result, reason, method, device and address) and
   Audit log (both tabs: the environment and **Install**). The audit log is a normal database table, not tamper-proof, and reads are not logged. A manual **Back up now**
   (passphrase, kept at the customer) freezes the state; it stays on their premises.
3. **Contain (reversible first):**
   - Disable affected accounts (Users, stop button: ends their sessions at once) or **Sign out everywhere** (Users > menu > Sessions).
   - Force password changes: **Create one-time reset code** (a reset ends every session) for affected people; check **Must change after** policy only if required.
   - Revoke **API keys** (Admin console > Service accounts > Revoke; stops at once); disable the service account; **Rotate** webhook addresses/secrets
     ([Webhooks](../../guide/maker/webhooks.md)); pause flows if the admin kill switch exists (**VERIFY**: flows are in progress).
   - Require two-step verification for administrators (Admin console > Sign-in and security > Required for > Administrators, grace period short).
   - If exposed to the internet: close the exposure (`Stop-Service Appbuilder-Caddy` on Windows; firewall) while investigating.
   - A leaver: disable, do not delete (SEC-15).
4. **Investigate** with the sign-in log and the audit log. Look for (action names from the audit docs): `auth.login`, `auth.login_failed`, `auth.login_throttled`,
   `auth.mfa_failed`, `auth.mfa_disabled`, `auth.recovery_code_used`, `auth.password_changed`, `auth.password_reset`, `user.create`, `user.roles`, `user.password`,
   `user.reset_code_created`, `user.mfa_reset`, `user.import`, `role.update` (privileges before/after), `install.admin_grant`, `install.service_account_create`,
   `install.api_key_create`, `install.security_policy`, `install.email_settings`, `connection.*`, `solution.*`, `row.delete`/`row.update` (columns only), `backup.download`,
   `backup.restore`, `environment.export_data`, `environment.delete`, `diagnostics.bundle`, `setup.code_rejected`, `schema.migrate`. Questions: first suspicious event; accounts
   and addresses; did anything download a backup or export data (those are the exfiltration paths the product logs); were roles or admins added; any changes at night.
   **Limits:** nothing records which rows were read; row updates record only the columns changed, not values.
5. **Eradicate:** change passwords of affected accounts; **rotate secrets that the attacker could have read** (connection passwords at the source systems and in Appbuilder;
   the mail relay password; API keys; webhook tokens). Rotating `.secret-key` and the database password is **not documented**: **VERIFY WITH ENGINEERING**. Update to the
   latest release ([runbook 1](#runbook-1-server-will-not-start-after-an-update) steps for safe updates); check `release-check.json` in a bundle (program files still match the release's checksums).
6. **Recover:** if data was tampered with, restore from a backup that predates it ([runbook 10](#runbook-10-accidental-mass-delete) for tables,
   [runbook 3](#runbook-3-restore-from-backup-onto-a-new-pc) for the whole system on a **clean** machine in a ransomware case).
7. **Communicate:** macro 36 (customer incident), 38 (data issue), 39 (security report acknowledgement). Say what we know and do not know. The customer decides on regulators and
   affected people with their own legal advice; we provide the factual timeline.
8. **Afterwards:** a [post-incident review](macros.md#post-incident-review-template) within 5 business days; add product/doc fixes to the feedback list.

**Prevent:** hardening checklist (two-step for admins, HTTPS, no internet exposure without need, second administrator, weekly audit review). **Not confirmed:** secret rotation
steps, the flow kill switch, whether the sign-in log can be exported (it is viewed in the page).

---

## Runbook 10: Accidental mass delete

**Severity** S1 in Production. **Source:** [Backup and restore: Restore (selected tables, in place, as a new environment)](../../admin/backup-and-restore.md#restore),
[Audit log](../../admin/audit-log.md), [Core data model](../../guide/maker/core-data-model.md#in-solutions), [Jobs: schedules](../../admin/jobs.md#schedules-and-retention),
[Data model designer](../../guide/maker/data-model.md) (delete behaviours). There is **no recycle bin**.

**Steps**

1. **Stop the damage:** ask people not to edit or delete in that table; if needed remove the Delete/Update privilege from the roles for now (Security roles) or
   disable the account that is deleting (an event or automation could be the actor: check Events run log, Jobs). **Make a Back up now (that environment)**: it is the safety copy.
2. **Establish what was deleted:** Admin console > Audit log (the environment tab): `row.delete` with `{count, deleted, ids}` (ids of at most 1,000 rows, then truncated;
   **no values**), who and when (UTC); `import: true` means a replace import. Check the table's **delete behaviours** in the Data model designer: a relationship set to delete
   related rows may have removed more rows in other tables. Deleting a record also removes its comments, mentions, tags, follows, activities and attachment links.
3. **Pick the backup:** Admin console > Backups: the newest good backup **before** the delete time (nightly 02:00, or the environment's own schedule, or the safety backup of
   an earlier risky change). **Pin it** so retention cannot remove it. Open **Restore** and **Browse** the table as it was (read-only, page by page) to confirm the rows are there.
4. **Choose the way** (the dialog shows a plan of rows now vs in the backup):
   - **Selected tables, as new tables** (safest): "<name> (restored <date>)", new table id, rows keep their ids, attachments copied with new ids. Then copy back
     the missing rows (a maker/administrator, with Import CSV/Export CSV or a formula `Collect`/`Patch`; test on a few rows first).
   - **Selected tables, replacing the rows** of the existing table: **discards everything entered since the backup**; needs a tick; one transaction.
   - **The whole backup as a new environment**: to compare or when many tables were hit.
   - Not restorable this way: tables stored outside the system database (data files, linked tables of other connections), views. Restore the environment instead.
5. **After the restore:** table events do **not** run for restored rows; refresh rollups (Admin console > Jobs > schedules > **Run now** "Rollup reconcile"); check owners and
   sharing; check attachments open. **VERIFY WITH ENGINEERING** whether comments, tasks and attachment links of the deleted records come back with selected-table restores (the
   docs say system tables hold them; the restore of selected tables is described for user tables).
6. **Tell the users the loss window** (from the backup time to the delete time): they re-enter those changes. Macro 28, 38.
7. **Verify** counts against the audit `count` and the manifest; spot-check; make a fresh backup.
8. **Prevent:** Production locked; Delete privilege limited; **Back up now** before bulk operations; hourly environment schedule for busy tables; the product gap (no undo/soft delete).

**Not confirmed:** system-table content in selected-table restores; time to restore a very large table (the doc's measurement: 1,000,000 rows restore as a new environment in about
16 seconds in the sandbox, on a fast machine).

---

## Runbook 11: Environment deleted by mistake

**Severity** S1 if Production, else S2. **Source:** [Environments: Delete one](../../admin/environments.md#delete-one),
[Back up and restore an environment](../../admin/environments.md#back-up-and-restore-an-environment), [Backup and restore: Automatic backups before risky changes](../../admin/backup-and-restore.md#automatic-backups-before-risky-changes),
[Restore](../../admin/backup-and-restore.md#restore).

**What happened (by design):** deleting asks the administrator to **type the environment's name**; a **backup of that environment is taken first** when automatic backups are on; if
that backup fails, nothing is deleted unless the administrator chooses **Delete without a backup**. The Default environment and the last production environment cannot be deleted.

**Steps**

1. Admin console > Audit log > **Install** tab: `environment.delete` (who, when). Note the environment id and name.
2. Admin console > Backups: look for the **automatic** backup of that environment taken just before ("Before: delete") and for install backups from the nightly schedule. If
   "Delete without a backup" was used, the nightly **install** backup (it contains every environment) is the way back; data since that backup is lost.
3. **Restore > As a new environment** (recommended): choose the backup, choose the environment inside it, give it a name and a type (it counts against the limit of 5: delete a
   failed/unused one first, or raise `APPBUILDER_MAX_ENVIRONMENTS`). By default only the person restoring can enter it (as its administrator) and connections to other systems lose their
   passwords, like a copy; tick the options to keep people's roles from the backup or the passwords if the customer agrees.
4. **Give access** to the people (Environments > Access), re-enter connection passwords, check it is the right **type** and **Locked** setting (Production: lock again), **Connections > Test**.
5. **Pending jobs and undispatched events** from the moment of the backup are cancelled (they would act twice); flows turned on? (flows are in progress: **verify**); scheduled reports and backup schedules of
   that environment: check they exist and are on.
6. Check apps, row counts, attachments; make a new backup; tell users the loss window and that their tabs may need reopening (app tabs belong to an environment).
7. **Prevent:** keep automatic backups on (Backups > Settings); few install administrators; typed confirmation is the only guard (no second approval exists).

**Communicate:** macros 28, 38. **Not confirmed:** whether the restored environment can take the same id as the deleted one (the id comes from the name; the audit entry shows the old id); how
solution identities map after a restore (ids are kept in the backup, so deploys should still upgrade in place: **verify**).

---

## Runbook 12: Failed solution upgrade

**Severity** S2 (blocks a release) or S1 if production behaviour changed wrongly. **Source:** [Solutions: Deploy to another environment](../../guide/maker/solutions.md#deploy-to-another-environment),
[Upgrades: Solution upgrades in an environment](../../admin/upgrades.md#solution-upgrades-in-an-environment),
[Backup and restore: Automatic backups before risky changes](../../admin/backup-and-restore.md#automatic-backups-before-risky-changes).

**Key fact:** an upgrade applies **exactly the plan that was reviewed, in one transaction**: if anything fails, the target is exactly as before. Before changing anything it takes a backup of the
target environment; if that backup fails the dialog offers **Upgrade without a backup** or Cancel.

**Steps**

1. **Confirm nothing changed:** target environment: apps, tables, roles as before (Environments > details; the solution's version); Audit log: no `solution.upgrade`/`solution.install` entry for it (a
   successful one records the version, counts, `destructive` and `backup: none|taken`).
2. **Read the failure:** common causes: a value that does not convert to a column's new type (the whole deployment stops); changed **unique pairs** where rows in the target repeat a pair; a **Problem** in the plan
   (a table in another database in the target, a lookup to a missing table, a change of table kind); the target changed since the plan ("review the new plan"); not an **administrator** of the target
   (upgrading what exists needs one); the environment is **locked** (import/deploy is allowed; direct changes are not); an event that runs as the system needs an administrator tick; a flow's connection
   has no match in the target (choose one).
3. **Fix the cause** in the solution (Sandbox) or in the target data (for example clean the values or duplicates that block a conversion), then **Review plan** again and read the red items. Do not choose
   "Upgrade without a backup" unless the customer has a fresh manual backup.
4. **If the upgrade succeeded but the result is wrong** (the problem is a wrong release, not an error): the result names the backup taken before. Restore it **in place** (type the environment name; a safety backup
   is taken first; during it the environment is "Restoring") or **as a new environment** to compare ([runbook 11](#runbook-11-environment-deleted-by-mistake) steps 3 to 5). Rows entered since the backup are
   lost with an in-place restore.
5. **New flows arrive turned off** in the target; connections arrive without passwords; roles never carry the administrator flag; rows are never replaced ("Include rows for new tables" fills only new tables).
6. **Verify:** open the apps as a restricted user (Test as user), check the new columns/rules, **Connections > Test**, run one real transaction in the app, make a new backup.
7. **Prevent:** deploy to a Sandbox copy of production first; read the plan with the customer; keep automatic backups on; avoid dropping columns in the same release as renaming them.

**Communicate:** macros 38 if data changed; 28 for a restore. **Not confirmed:** behaviour of very long upgrades on big tables; exact error text of each failure (the docs give causes, not messages).

---

## All VERIFY WITH ENGINEERING items in one list

1. Manual rename of `app` / `app.previous` when `app.failed` already exists; permissions after a manual rename (runbook 1).
2. Crash-loop diagnosis path (runbook 1).
3. Where PostgreSQL's own log lives for the installer-made cluster; Linux service name for the PGDG package (runbook 2).
4. `appbuilder restore --check` on the installed command (runbook 3); whether Caddy's local CA is restored or re-made, and what clients must do (runbook 3).
5. Include-key backup from a running server whose `.secret-key` file is gone (runbook 4); installer repair mode with a missing key (runbook 4).
6. Password-only re-authentication when two-step verification is on (runbook 5 step 4); **a tested procedure to clear two-step verification for the last install administrator** (runbook 5 step 7).
7. PostgreSQL behaviour on a full disk; how to relocate `pgdata` (runbook 6).
8. Which row-rule shapes are expensive at scale; antivirus effects; behaviour at 50 concurrent users (runbook 7).
9. Retrying system emails after an outage (runbook 8); relay providers that need OAuth.
10. Secret rotation (`.secret-key`, database password), the flows kill switch, exporting the sign-in log (runbook 9).
11. Whether selected-table restore brings back comments, tasks and attachment links (runbook 10).
12. Restoring an environment under the same id; solution identity after restore (runbook 11).
13. Exact messages of solution upgrade failures (runbook 12).
