# Support model: one founder, on-premises customers in India

Status: working draft, 19 Nov 2026. Written to the constraints in [../BRIEF.md](../BRIEF.md): version 0.5.0, no customer
yet, no pilot yet, no outside security review, Windows installer not yet proven on a customer machine, one founder
building with AI agents, pricing not decided. Everything about the product comes from the repository docs; anything
about prices of outside tools comes from third-party web pages read on 19 Nov 2026 and **must be re-checked before
buying**. Prices, hours and percentages in this file are **proposals for the owner to decide**, not commitments.

Contents: [1 Principles](#1-principles) - [2 Tiers](#2-support-tiers-pilot--licence--amc) - [3 Channels](#3-channels) -
[4 Severity](#4-severity-definitions) - [5 Targets](#5-response-and-resolution-targets-one-person-can-keep) -
[6 Escalation and on-call](#6-escalation-and-on-call-reality) - [7 Maintenance windows](#7-maintenance-windows) -
[8 Update policy](#8-update-policy) - [9 Backup responsibility](#9-backup-responsibility-who-does-what) -
[10 Data access rules](#10-data-access-rules-for-support-staff) - [11 Onboarding](#11-customer-onboarding-checklist) -
[12 Training](#12-training-plan) - [13 Health checks](#13-health-check-cadence) - [14 Churn signs](#14-churn-warning-signs) -
[15 Tooling](#15-tooling-now-and-later) - [16 Cost per customer](#16-cost-per-customer-estimate) -
[17 First hire](#17-when-to-hire-the-first-support-person)

## 1. Principles

1. **Be honest about size.** One person, India time zone, business hours. We promise only what one person can keep, and
   say so in writing. A missed promise costs more trust than a modest one.
2. **Self-service first.** The product already has the tools a support person needs: Admin console > Server logs (health,
   filtered log), the **Diagnostics bundle**, Admin console > Usage, Test as user and Who can see a row?, the Jobs and
   Events run log pages, the Email delivery log, the audit logs and the sign-in log. Support starts by asking the customer's
   administrator to read those, not by logging in ourselves.
3. **No passwords, ever.** We never ask for a password, a recovery code, an authenticator code, the `.secret-key` file,
   a backup passphrase or a database password. We use the diagnostics bundle (secrets removed) and a screen-sharing
   session in which the customer's own administrator types.
4. **Production data stays on their premises.** See [section 10](#10-data-access-rules-for-support-staff).
5. **Every fix becomes a doc, a macro or a product fix.** A case seen twice goes into [macros.md](macros.md) or
   [runbooks.md](runbooks.md); a case seen three times goes to engineering as a gap
   ([support-use-cases.md](support-use-cases.md) marks the known ones).
6. **Account for the founder's employment situation.** The BRIEF says the founder is serving notice at an Indian IT
   services company with a no-moonlighting policy until about the end of January 2027. No customer-facing support
   commitment, support contract or live pilot support should start before the entity and timing questions are settled
   with a lawyer/CA. Until then this document is a plan, and the practice material (macros, runbooks, help centre) can
   be tested on a demo install only.

## 2. Support tiers: Pilot / Licence / AMC

AMC = annual maintenance contract. How the product is licensed is not decided (BRIEF: idea of one licence per install by
seat band 25/50/100). The table below says what *support* each commercial form would carry. "Proposed" means it is for the
owner to decide.

| | **Pilot** (proposed 60 to 90 days, first customer only) | **Licence** (proposed: first 90 days after go-live) | **AMC** (proposed: yearly, after the first 90 days) |
| --- | --- | --- | --- |
| Install on the customer's PC/server (remote, with their IT person) | Yes | Yes | Re-install / move to a new machine: 1 per year |
| Onboarding checklist ([section 11](#11-customer-onboarding-checklist)) | Yes | Yes | Not needed |
| Training: admin 2 h, makers 4 h, users 30 min ([section 12](#12-training-plan)) | Yes, all three | Yes, all three | One refresher session per year (2 h) |
| Channels | Email + WhatsApp Business, phone call by appointment | Email + WhatsApp Business, phone for S1 | Email + WhatsApp Business, phone for S1 |
| Targets | Best effort, aimed at the targets in [section 5](#5-response-and-resolution-targets-one-person-can-keep); **no SLA, no penalties** | Targets in section 5, stated as targets, not guarantees | Targets in section 5; credits or penalties only if a lawyer agrees to write them |
| Release packages (updates) | Yes, we help apply them | Yes | Yes (included while the AMC is active) |
| Health check ([section 13](#13-health-check-cadence)) | Weekly 15 min call | Monthly async | Quarterly 60 min |
| Restore drill (`restore-drill` style, on a spare machine) | Once, together | Once, together | Once a year, assisted |
| Fixes for bugs in the product | Yes | Yes | Yes |
| New features, custom apps built for them, data migration from other systems | By agreement, priced separately; not support | Same | Same |
| Remote access to their machine | Only in a session they start ([section 10](#10-data-access-rules-for-support-staff)) | Same | Same |
| Hours | Mon to Fri 10:00 to 18:00 IST (proposed) | Same | Same; S1 phone line until 20:00 IST (proposed) |
| What it is **not** | 24x7, on-site visits, support for their other software (Tally, Windows, printers, network, antivirus) | Same | Same |

Why a pilot without an SLA: no outside security review, an unproven Windows installer and no customer track record. The
pilot's job is to find what breaks (every gap goes to [README.md](README.md) section "Feedback to engineering"); it is
not the moment to sell guarantees. Say this in the pilot agreement in plain words.

Out of scope for every tier (say it at the start, not at the first incident): the customer's hardware, power, network,
Windows updates and antivirus; their other databases and Google Sheets (the backup docs say Appbuilder does not back those
up); their staff's training beyond the sessions listed; content of their apps built by their own makers (we help find the
cause, we do not own their formulas); legal advice about data protection.

## 3. Channels

| Channel | Use | Rules |
| --- | --- | --- |
| **Email** (shared mailbox, e.g. support@<our domain>) | The official channel and the record. Everything that matters ends up here. | Every ticket gets an ID in the subject (`[SUP-0042]`). One issue per email. |
| **WhatsApp Business** | Fast, informal contact with the customer's administrator; sending screenshots; "is it down?" | Not for diagnostics bundles, backup files, keys, passwords or anything with customer data. Summarise any decision in email the same day. See limits below. |
| **Phone** | S1 only, plus scheduled calls (training, health checks). One number, published hours. | We call back; we do not promise to pick up. Voicemail says the hours and the email address. |
| **Remote session** | Last resort for things that cannot be read from a diagnostics bundle (installer problems, Windows service problems, a screen only they can see). | The customer starts it, the customer's administrator drives, we watch and talk. Recording is off unless both agree. |
| In-product help | The help centre in [../../help/index.md](../../help/index.md) for staff; admin docs for administrators. | |

**Customer-facing contact points:** one administrator and one deputy per customer (two named people). End users go to
their own administrator first; we do not support individual operators directly (we cannot see their screens, and it
multiplies the load). This is a hard rule in the pilot agreement.

### WhatsApp Business: what the limits mean for us

Read from third-party guides on 19 Nov 2026 ([AiSensy](https://m.aisensy.com/blog/whatsapp-business-app-vs-api/));
confirm on Meta's own pages before relying on any of it.

- The free **WhatsApp Business app**: one phone plus up to four linked devices, broadcast lists of at most 256 contacts and
  only to people who have your number saved, only basic away messages and quick replies. This is enough for a solo founder
  with a handful of customers. Use a **separate SIM and number** for support (not the founder's personal number), set the
  business profile hours, an away message and quick replies.
- The **WhatsApp Business Platform (API)** needs a provider (BSPs charge a monthly platform fee, the same guide quotes
  from about 1,500 rupees a month plus Meta's per-message charges: about 1.09 rupees for a marketing message, about 0.145
  for utility and authentication messages, service conversations started by the customer free). Billing unit
  (conversation or message) is stated inconsistently there; check. **Do not buy this now**: it only becomes useful when
  there are several support people or we want automated status messages.
- Meta's rules on marketing/broadcast to people who did not opt in apply; incident notices to named customer contacts are
  service messages, but ask the lawyer to review our terms.
- WhatsApp as a *product* feature is planned (P2 Reach), not built. Do not mention it to customers as available.

### Remote support tools: options, licences, costs

None of these is needed to start. Prices below are from aggregator pages ([Zoho Assist and others on CostBench](https://www.costbench.com/software/remote-desktop/zoho-assist/),
[RustDesk](https://www.costbench.com/software/remote-desktop/rustdesk/), [AnyDesk vs TeamViewer](https://costbench.com/compare/anydesk-vs-teamviewer/),
[Chrome Remote Desktop vs Quick Assist](https://www.selecthub.com/remote-desktop-software/chrome-remote-desktop-vs-quick-assist/)),
in US dollars, read on 19 Nov 2026, and the pages themselves say they are inconsistent or low confidence in places.
**Verify on each vendor's own page and ask about GST/INR billing before buying.**

| Option | Cost (as read) | Good for | Watch out |
| --- | --- | --- | --- |
| **Microsoft Quick Assist** | Included with Windows 10/11 | Customer starts it with a code; no install on our side beyond Windows. Zero cost: **default for the pilot**. | Windows only; no built-in file transfer; the Store version may need administrator rights on the customer's PC; Windows-to-Windows (our own machine must be Windows with a Microsoft account; verify). |
| **Chrome Remote Desktop** | Free | Linux servers with a desktop; attended or unattended access | One session at a time; reported 30-minute session limit; no file transfer or chat. Requires a Google account on both sides. |
| **Zoho Assist** | Free plan: 1 technician, 1 concurrent session, 5 unattended computers. Paid: about $10 to $24 per technician per month (Standard, Professional, Enterprise) as listed | Purpose-built support tool with a customer join link, unattended access, chat, file transfer and session reports (useful as evidence of what we did) | Confirm the unit of the unattended plans with Zoho. Indian partner resellers exist (INR billing). |
| **AnyDesk** | Listed at about $50 per month (Standard, annual billing) for small teams; a cheaper Solo plan about $277 per year | Light, fast, familiar to Indian IT staff | Free use is for personal use; the vendor detects commercial use and asks for an upgrade. Customers often already run it: ask what they have. |
| **TeamViewer** | About $25 to $51 per month by plan as listed | Very widely installed | Same commercial-use detection; most expensive of the group. |
| **RustDesk** | Free if self-hosted (we run our own relay server, MIT-licensed server software); paid Pro about $12 to $24 per month, annual only | Cheap, self-controlled, no third-party servers; a good later option | We must run and patch the relay; per-device counting on the Pro plan; a security-conscious customer will ask who runs the relay. |
| **SSH / VPN to a Linux server** | Free | A customer that runs Linux: use SSH with their IT person, or a tunnel as the installation docs already describe for first-run setup (`ssh -L 5174:127.0.0.1:5174`) | Needs the customer's IT to open it; never leave it open. |

Recommendation: Quick Assist (Windows) or the customer's own preferred tool for the pilot, Zoho Assist free plan or a
paid Zoho seat once there are three or more customers, review RustDesk when there are ten. Whatever the tool: the customer
starts and ends the session, the customer's administrator types, we never save a customer's unattended-access
credentials, and we write down start time, end time, reason and what was done ([section 10](#10-data-access-rules-for-support-staff)).

## 4. Severity definitions

Severity is set by the **impact on the customer's work**, by us, after one question: "who cannot work, and is there a
workaround?" The customer may ask for a higher severity once; we explain if we disagree.

| Severity | Definition | Examples (all from [support-use-cases.md](support-use-cases.md)) |
| --- | --- | --- |
| **S1 Critical** | Production is unusable for everyone, or data is lost or wrong in a way that spreads, or there is a suspected security breach. No workaround. | Server will not start after an update and did not roll back; PostgreSQL gone or disk full and the service is down; a restore is needed; suspected unauthorised access; accidental mass delete in production; the only administrator is locked out and production needs a change |
| **S2 High** | An important function is broken for many people, or the install is at serious risk, and there is no good workaround. | Nobody receives password reset or approval emails; nightly backups failing for more than a day; a failed solution upgrade blocking a release; an environment shows Failed; slow queries stopping a whole shift; a lost `.secret-key` with a restore not yet needed |
| **S3 Normal** | One person or one app is affected, or there is a workaround. The large majority of tickets. | "I cannot see my orders"; a formula error; a report not arriving for one person; a validation message the maker should change |
| **S4 Low** | A how-to question, a cosmetic issue, documentation, a feature request, a planned feature asked for. | "How do I print this?" (PDF output is planned); "Can the app work on a phone?" |

Rules: a **security report** is handled as S1 until triaged (macro 39 acknowledges within the S1 target). A question
asked twice becomes S3 even if it is a how-to. A feature that the BRIEF lists as planned is S4 with a macro
(macro 30) and a note in the demand list.

## 5. Response and resolution targets one person can keep

Business hours are **Mon to Fri, 10:00 to 18:00 IST, excluding the founder's declared leave and public holidays announced
in advance** (proposed; Saturdays by agreement in the first weeks of the pilot). "Response" is a human reply with a
plan or a question, not an auto-reply. "Resolution" is a workaround or fix in place, or a clear date for the fix.

| Severity | First response | Resolution target | Outside business hours |
| --- | --- | --- | --- |
| S1 | 1 business hour (phone call back, then email) | Workaround or restore under way within 4 business hours; full fix as soon as possible | Best effort: phone to the founder's support number; **no guarantee**, no 24x7. Say "we will see it at 10:00 next business day at the latest" |
| S2 | 4 business hours | 2 business days | None |
| S3 | 1 business day | 5 business days (often much faster) | None |
| S4 | 2 business days | Answered, or logged for a later release; no date promised | None |

What makes these keepable: a diagnostic bundle on the first reply; macros and runbooks; no more than about 3 customers in pilot or
onboarding at the same time (steady-state capacity and the hiring triggers are in
[section 16](#16-cost-per-customer-estimate) and [section 17](#17-when-to-hire-the-first-support-person)); the founder's calendar blocks
two 45-minute "support windows" a day (for example 10:30 and 16:00) when nothing else is scheduled. If the founder is
away more than one business day, the auto-reply and a message to each customer's administrator says so, with the return
date. **What we do not promise:** a time to fix a product bug (we promise a response, a workaround where one exists and a
date to the next update), and a restore time on a customer's hardware.

Honest limits to tell the customer: a single S1 can take the founder's entire day; two S1s at once will be handled one
after the other; there is no night or weekend cover. A customer who needs that should wait for a second support person or
accept a different supplier. Better to lose that deal than to promise it.

## 6. Escalation and on-call reality

| Level | Who | When |
| --- | --- | --- |
| 1 | Founder (support hat) | Everything |
| 2 | Founder (engineering hat), with AI coding agents on the code | Bugs, data repair, "verify with engineering" items in [runbooks.md](runbooks.md) |
| 3 | An outside specialist agreed in advance (PostgreSQL consultant, Windows administrator) | Database corruption, hardware failure; paid per hour; a name and phone number kept in the shared sheet |

There is no on-call rotation, because there is nobody to rotate with. What exists instead:

- **A published S1 phone number** that rings the founder in business hours and, by agreement, until 20:00 IST in AMC
  mode. After that, voicemail and the next-morning rule.
- **A "break glass" contact for the customer**: the customer's administrator knows the pre-written steps in the runbooks
  for the first thirty minutes (check health, check disk, do not restart repeatedly, do not delete anything, send the
  diagnostics bundle). Most S1s on a single machine start with exactly these.
- **The product restarts itself** on failure (Windows: after 10, 30 and 60 seconds; Linux: after 5 seconds) and rolls the
  program folder back by itself when an update does not become healthy ([Upgrades](../../admin/upgrades.md)), which removes
  the most likely night-time S1.
- **No unattended customer-side change at night.** No updates in the evening or on Fridays, and nothing the founder cannot
  be present for the next morning.
- **A written downtime plan in the customer's hands**: what the customer does when Appbuilder is down for a day (paper
  forms, Excel template, WhatsApp group). The pilot agreement names it. Until the product has proven itself, it must not
  be the only copy of anything important for a shift.

If a second S1 arrives while one is being worked: acknowledge it within the target, tell the customer the honest queue
position, ask the customer's administrator to run the first-thirty-minutes steps, and work in order of data risk (data loss,
then security, then outage).

## 7. Maintenance windows

- **Customer-side window:** agreed per customer at onboarding. Proposed default: a weekday, 30 minutes, outside shifts
  (for a manufacturer with day shifts: 19:00 to 19:30 IST), never Friday, never the last working day of a month. The nightly
  backup runs at 02:00 server time ([Backup and restore](../../admin/backup-and-restore.md#schedules-and-retention)): do not schedule an
  update within an hour of it.
- **What is in a window:** applying a release package, restarting the service, a restore drill on a spare machine, changing
  the HTTPS setup. The service is stopped for about a minute for an update, longer when the database is migrated and large
  ([Upgrades](../../admin/upgrades.md#before-you-update)).
- **Notice:** 3 business days for planned work (macro 35), same day for urgent security updates.
- **Our own side:** our website and support mailbox have no windows we promise; if our mail is down the customer rings.
- **Nothing here is a hosted service.** Appbuilder is installed on the customer's machine, the server never contacts us
  ([Upgrades](../../admin/upgrades.md)). We have no uptime to promise; the customer's machine, power and network set it.

## 8. Update policy

| Item | Policy (proposed) |
| --- | --- |
| How updates reach the customer | We send a release package `appbuilder-<version>.zip` and its published SHA-256 by email or a download link. Nothing downloads automatically and there is no update notification inside the product (stated as not supported in [Upgrades](../../admin/upgrades.md#not-supported-yet)). |
| Cadence | While the version is 0.x: a release when something important is fixed, not on a calendar; aim for at most one a month per customer so that the founder can attend each update. Security fixes: as soon as tested, customer told the same day. |
| Supported versions | The current version and the one before it. A customer two or more versions behind is asked to update first (macro 34). The updater refuses downgrades, so we never ask a customer to go back without a matching database restore. |
| Who applies it | The customer's administrator, with us on a call for the first three updates of every customer, then on their own with the checklist. |
| Before | Read `RELEASE-NOTES.md` (in the package, or Admin console > Updates after uploading it). Check the SHA-256. **Back up now** (whole install) and make sure a copy is off the machine. Check Admin console > Server logs is green. Announce about one minute of downtime. |
| How | Upload the zip in **Admin console > Updates** (the page checks checksums, signature, requirements and shows the release notes), then in an elevated PowerShell (or root shell) run the one command the page shows: `appbuilder update --staged`. Or `appbuilder update <zip>` directly. ([Upgrades](../../admin/upgrades.md#update-an-installed-server)) |
| After | The updater waits for `GET /api/v1/health` to answer `ok`. Then sign in, open one app, **Connections > Test** on each connection, look at Admin console > Server logs and Updates (the history). Tell us the result. |
| Signatures | `release-keys.json` is empty in the repository today: until the founder makes a signing key, releases are unsigned and installs accept unsigned updates, and say so ([Release process](../../dev/release-process.md#signing)). **Make the key before the first customer update.** |
| Rollback, app only | Automatic when the new release does not become healthy (the failed folder is kept as `app.failed` for us). By hand after a successful update: stop service, rename `app` to `app.failed`, `app.previous` to `app`, start. Enough only if the release did not change the database schema (`appbuilder version` and the notes say). |
| Rollback, database | Never automatic. If the new release migrated the database and then failed, the previous release refuses the newer schema. The updater names the pre-migration backup and the `appbuilder restore ... --force` command. A restore discards everything written since that backup: a **person decides, with us** ([runbook 1](runbooks.md#runbook-1-server-will-not-start-after-an-update)). |
| Windows | The installer and updater have not run on a real Windows machine yet ([Release process](../../dev/release-process.md#first-run-on-windows-what-to-check)). The first customer's first install is therefore a test; do it on a day when nobody depends on it. |
| Not supported | Zero-downtime updates; updating from the browser; automatic updates. |

## 9. Backup responsibility: who does what

Stated plainly, and put in the pilot agreement and the onboarding checklist. Appbuilder backs itself up; the customer owns
the backups.

| | **The product (Appbuilder) does** | **The customer does** | **We (support) do** |
| --- | --- | --- | --- |
| Nightly install backup at 02:00 server time, verified after writing, retention 7 daily / 4 weekly / 3 monthly | Yes, on by default | Keep the server on and the disk not full at night | Check it at onboarding and in every health check |
| Warning when the last good backup is older than 36 hours (notification to install administrators, backup health on every Admin console page) | Yes | Look at it; make sure someone reads the notification | Ask for a screenshot monthly |
| A copy **off the machine** (off-site folder in Admin console > Backups > Settings, or rclone/restic, or a USB/NAS rotation) | The off-site folder setting only copies; the product does not upload anywhere | **Set it up and keep it working.** A backup on the same disk does not survive a disk failure, fire or ransomware | Help set it up; confirm it in the first week |
| Keeping `.secret-key` and the backup passphrase **apart from the backups** (password manager or safe) and a second copy of each | Nothing: it cannot | **Do it.** Without the key a restore on a new machine loses connection passwords, the mail password and two-step secrets. Without the passphrase an encrypted backup cannot be opened by anyone | Check at onboarding that two named people know where they are. We never hold them |
| Backing up other databases and Google Sheets the customer connected | No | Yes | Remind |
| Restore drill (on a spare machine) | A scripted drill exists for us, and the Backups page has a Restore test option | At least once a year and after major changes; turn the weekly **Restore test** on | Run the first one with them |
| Windows/Linux patching, hardware, power, disk space, UPS | No | Yes | Advise |
| A second install administrator | No | Yes (so one lost password does not lock the install) | Check at onboarding |
| Doing the restore | Command and screens exist | Ideally their IT person, **on a call with us** | Guide; we do not restore on their behalf without the written request in [section 10](#10-data-access-rules-for-support-staff) |
| Holding customer backups at our place | No | No | **No.** A backup contains every table, password hashes and data. We never take one away; we reproduce problems on synthetic data |

Be explicit about what we **cannot** do: recover a lost encryption key or a lost backup passphrase (an encrypted archive
cannot be opened without the passphrase), restore to a point between two backups (no point-in-time recovery; the docs say
to set up PostgreSQL WAL archiving yourself), or bring back data from a server whose disk and backups are both gone. The
lawyer should review how this is written in the agreement, since it limits liability.

## 10. Data access rules for support staff

These are rules for us (today: the founder; later: every support person signs them).

1. **No access to production data without a written request.** An email from an authorised person at the customer
   (named in the contract), saying what we may look at, why, from when to when. Macro 6 is the template. A request lasts
   for one issue; it is not standing permission.
2. **Default path, no data access:** the diagnostics bundle (secrets removed, e-mail addresses shortened; it contains
   no table contents, no backups, no attachments, no `.secret-key`; it does name tables, environments and host names, so the
   customer's administrator looks inside before sending) and the customer reading screens to us. The bundle download is
   itself recorded in the install audit log (`diagnostics.bundle`).
3. **Screen sharing: the customer's administrator drives.** We never take control of the mouse in a production environment.
   If a change must be made, we say the click path; they do it. Exception: the written request says otherwise, and the
   customer's administrator is present for the whole session.
4. **No passwords, keys or codes.** Not by chat, email, phone or screen share. If a screen shows one, we ask the customer to
   move it. The one-time reset code an administrator creates for a user is for that user, not for us.
5. **No separate account for us by default.** If we truly need an account (for a long test as a restricted user), the
   customer creates a named, temporary account with the minimum roles, disables it afterwards (disabling ends its sessions at
   once), and the audit log shows what it did. Never a shared login, never the customer administrator's.
6. **No data leaves the premises.** No database dumps, no backups, no CSV exports of real rows, no screenshots with
   customer data kept longer than the ticket (delete them when closed; redact before pasting into a bug report). To
   reproduce a bug we build a synthetic table with the same columns and roles.
7. **We log our own access.** A sheet ([section 15](#15-tooling-now-and-later)) with: date, ticket, who, what was
   requested, request reference, what we viewed or changed, time started and ended, whether data was seen. The customer can
   ask for it at any time. The customer's own audit log (`auth.login`, `solution.*`, `backup.*`, `diagnostics.bundle`) is the
   second witness; note that reads of data are **not** audited by the product ([Audit log](../../admin/audit-log.md#what-is-not-recorded)),
   so our own sheet is the only record of what we looked at.
8. **Confidentiality and data protection.** A confidentiality clause and a data-processing note in the customer
   agreement, written by a lawyer. This file is not legal advice and does not interpret India's data protection law.
9. **Security reports and incidents** follow [runbook 9](runbooks.md#runbook-9-suspected-unauthorised-access).
   Customer-side legal reporting duties are for the customer's counsel.

## 11. Customer onboarding checklist

Target: install to first real app in two weeks, calendar time. Owner of each step in brackets. Do not skip step 6.

1. **Before the first call** [us]: confirm the machine meets the sizing in [Installation](../../admin/installation.md#requirements-and-sizing)
   (Windows 10/11 or Server 2016 or newer, 4 GB minimum and 8 GB recommended, 3 GB free minimum, SSD, a second disk for backups);
   who the administrator and deputy are; how users will reach it (this PC only, the local network with HTTPS, a domain);
   whether the customer has internet at install time or needs the offline bundle ([Offline install](../../admin/installation.md#offline-install),
   about 450 MB of downloads for Windows); who can run an elevated PowerShell; agreed maintenance window; our remote tool.
2. **Install** [customer IT, with us on a call; pilot: the first Windows run is a test]: check the zip's SHA-256, run
   `install.ps1` (add `-Https Lan -OpenFirewall` for the office network), read the setup code
   from `C:\ProgramData\Appbuilder\workspace\setup-code.txt`. The install is repeatable ("run it again to repair").
3. **First-run setup** [customer administrator, on the server PC]: create the first administrator. Delete the sample data
   (Contacts, Orders, Contacts app) if they do not want it. If HTTPS for the LAN: install the local certificate authority file on every PC
   ([Installation](../../admin/installation.md#trust-the-local-certificate)), comparing the fingerprint first.
4. **Second administrator + roles** [customer admin]: create a **second install administrator**; create real roles (Administrator, Maker, a
   restricted role for operators); use **Test as user** on each. Turn on two-step verification for administrators in
   Admin console > Sign-in and security (the default is off).
5. **Email** [customer admin]: Admin console > Email: relay, sender, **public address**, **Send test email**. Without it
   invitations and reset links do not work and administrators issue temporary passwords and reset codes instead.
6. **Backup, schedule and key file** [customer admin + us]: confirm the nightly 02:00 backup is on and **Verified**; set the
   **backup folder** on a second disk and the **off-site copy**; save a **passphrase** for scheduled backups; copy `.secret-key` to a
   password manager or safe **apart from the backups**; record where the passphrase is; turn on the weekly **Restore test**; make one manual backup; **do one
   restore into a new environment** to see it work. Tick this off in writing.
7. **Users** [customer admin]: **Admin console > Users > Import CSV** or **Add user** with invitations (or temporary passwords
   without email). Departments, managers and teams if row security follows them ([Organisation](../../admin/organisation.md)).
8. **Environments** [customer admin + us]: a Developer or Sandbox for the maker, Default is Production; optionally lock
   Production once the first app is deployed ([Environments](../../admin/environments.md)).
9. **First app** [maker + us]: build the smallest useful app for the pilot (for a manufacturer: one shop-floor entry form +
   one list + one report), in Sandbox, then **Deploy to** Production through a solution ([Solutions](../../guide/maker/solutions.md)).
10. **Training** [us]: admin 2 h, makers 4 h, users 30 min ([section 12](#12-training-plan)); hand over the printable
    quick-starts in [../../help/](../../help/index.md).
11. **Go-live day** [both]: a quiet day; us on the phone for the first two hours; paper fallback ready.
12. **Day 7, day 30 reviews** ([section 13](#13-health-check-cadence)). Save the first **diagnostics bundle** as a baseline
    (kept by the customer, not by us).

Output: a one-page "install record" the customer keeps: version (`appbuilder version`), install folder, data folder,
workspace path, who the administrators are, where the key and passphrase are, the backup folder and off-site folder, the
window, how to reach us.

## 12. Training plan

All sessions on the customer's own install, with their own data model where possible. Sandbox, not Production.

### Administrator: 2 hours (the administrator and the deputy)

| Min | Topic | Show in the product |
| --- | --- | --- |
| 0 to 10 | Mental model: one install, environments, install administrator vs environment administrator | Environment picker; Admin console > Environments |
| 10 to 30 | Users and roles: invite, temporary password, reset code, disable; built-in roles; app access | Users, Security roles, **Test as user**, **Who can see a row?** |
| 30 to 45 | Sign-in and security: two-step policy, lockouts, sessions, lost phone | Sign-in and security, sign-in log, Reset two-step verification |
| 45 to 65 | Backups and the key file: schedule, retention, off-site, passphrase, `.secret-key`, restore as a new environment | Backups tabs; practice a restore |
| 65 to 80 | Health: Server logs, Usage, Jobs, Email delivery log, diagnostics bundle | Admin console > Server logs, Jobs, Email |
| 80 to 95 | Updates: how a release is applied, what rolls back | Updates page (walk through, do not run) |
| 95 to 110 | Environments and solutions: Sandbox to Production | Solutions > Deploy to... > Review plan |
| 110 to 120 | Questions; how to raise a ticket; what to send (bundle, time, user, screenshot); what we never ask | Macro 3 and 5 |

Hand-out: the hardening checklist, the runbook "first thirty minutes", the contact card.

### Makers: 4 hours (two sessions of 2 hours)

Session 1: tables and columns (types, Choice, Lookup, Autonumber), the Studio, a Start-with-data app, forms with
validation messages (the maker writes the message the operator will read), galleries and data tables, `User()` and why hiding
a UI component is not security. Session 2: formulas on the server (the "Runs on server / Runs in browser / Can't run" label,
Indexed columns, the 5,000-row and 15-second limits), validation rules, formula columns, rollups (and who sees the total),
events (before and after), Record timeline, SendNotification, scheduled reports, solutions and deployment, **testing as a
restricted user**, what to look at when something fails (formula bar, error list, Events run log). Exercise: build and
deploy the pilot's first app.

### End users (operators, supervisors, office staff): 30 minutes, groups of up to 15

| Min | Topic |
| --- | --- |
| 0 to 5 | Signing in, choosing a password, two-step verification if required, signing out |
| 5 to 12 | Finding and opening My apps; tabs; Open in new window |
| 12 to 20 | The app they use: forms, required fields, the message under a field, saving; "Reload / Keep mine" |
| 20 to 25 | Comments, mentions, tasks; the bell; email preferences |
| 25 to 30 | If something goes wrong: what to tell the administrator (time, what you did, the exact message, a screenshot) |

Hand out the one-page quick-start ([../../help/quick-start-operator.md](../../help/quick-start-operator.md)). Record the
session only if the customer agrees.

## 13. Health-check cadence

A health check is **read-only** and uses the customer's administrator's screen or a diagnostics bundle.

| When | What | Time (us) |
| --- | --- | --- |
| Day 1 after go-live | Call: any errors, Server logs, backup ran overnight | 20 min |
| Day 7 | Pilot: weekly 15-min call. Server logs health, last backup **Verified**, off-site copy present, Jobs (waiting, failures, dead), Email delivery log, sign-in log for repeated failures | 20 min |
| Day 30 | Review: usage (who signed in within 7 and 30 days), open tickets, feature requests, training gaps | 45 min |
| Monthly (async) | Customer sends screenshots of Admin console > Backups, Server logs (health) and Usage, or a diagnostics bundle. We check against the list below and reply | 15 min |
| Quarterly (AMC) | 60 min call: the monthly list plus disk growth, table sizes (Usage), slow screens, updates behind, users to remove, 2-step coverage, second administrator still exists, key and passphrase locations still known | 60 to 75 min |
| Yearly | Restore drill on a spare machine; review of roles and Makers; review of exposure (LAN/domain) against the hardening checklist | 3 h |

The list: backup age under 36 hours and **Verified**; off-site copy exists; disk space not under 10 % free; health `ok`
(Admin console > Server logs): clock difference under 5 seconds; no dead jobs older than a few days; Email delivery log not full of
failures; **version within one of current**; two install administrators; two-step policy still on for administrators;
no remaining temporary passwords; sign-in log without bursts of "Too many attempts" or "Wrong password"; no abandoned
accounts of people who left.

## 14. Churn warning signs

The product collects nothing over time and sends nothing to us ([Operations](../../admin/operations.md#usage)), so signals come from
health checks and conversations:

- Administrator champion leaves, changes role or goes quiet; only one person knows how it works.
- **Admin console > Usage** shows few people signing in within 7 days relative to the licensed band; or no one but the maker.
- No new app or change for 60 days; Makers building in Excel again; "we still do the real work in the WhatsApp group".
- Backups failing, off-site copy never set up, many updates behind, no second administrator (they are treating it as a toy).
- A tickets pattern: the same "why can't X see Y" again and again (a training or product gap), or a long open S2.
- Requests for features we have marked planned (phone layouts, PDF, dashboards, WhatsApp, SSO) several times: a fit problem.
- Questions about data export (**Admin console > Backups > Export data**) or how to get out; slow payment.
- Staff changes on the shop floor with no re-training; an unresolved dispute about an incident.

Response: a call from the founder within one business day of seeing two signs; a short written plan; ask what is blocking.

## 15. Tooling: now and later

### Now (with no customers, then up to about three)

- **A shared inbox:** one support mailbox on a normal mail provider, with a label per customer and a label per status
  (Open, Waiting for customer, Waiting for us, Done). A ticket ID in the subject (`[SUP-0042]`).
- **One spreadsheet** (three tabs):
  1. *Tickets*: ID, date opened, customer, contact, channel, severity, category (use the groups of
     [support-use-cases.md](support-use-cases.md)), case ID if matched, status, first response time, resolution time,
     product gap? (yes/no, roadmap phase), minutes spent, link to the email thread.
  2. *Access log* ([section 10](#10-data-access-rules-for-support-staff)).
  3. *Customers*: version, install type, windows/server, administrators, maintenance window, last health check, last
     backup confirmation, key location known (yes/no), renewal date.
- **A calendar** with support windows blocked and health checks as recurring entries.
- **Macros** in [macros.md](macros.md), stored as text snippets in the mail client.
- **Weekly 20-minute review (Friday):** open tickets, anything over target, new cases to add, gaps to engineering.

### Later: run support on our own product (dog-fooding)

Reasonable once the first pilot is stable, and a good proof of the product, but only for what exists today:

| Need | Built with what exists now | Needs what is in progress |
| --- | --- | --- |
| Ticket table, customers table, case catalogue | A table with columns Choice (severity, status), Lookup (customer), Date and time, Autonumber (`SUP-`), Currency/number for minutes; a validation rule for required fields; the **Record timeline** for comments, tasks, files, @mentions | |
| An agent app (list + form) and a customer-facing form | An app from "Start with data"; an operator-style role for support staff; Test as user | A form for outside people needs **external portal sites** (planned, P6): not available. Customers keep emailing us |
| Daily "tickets about to breach" list | A **scheduled report** (filter + sort, emailed each morning) | |
| Notify on a new S1, or when a ticket changes owner | A table **event** (`NotifyUser`) after saving | |
| SLA timers, escalation after N hours, approvals for access requests, reminders to the customer | | **Flows** (in progress) and **approvals** (in progress): do not rely on them yet |
| WhatsApp threads, a mail client | | Planned, not built |

Condition: our own support install runs on our infrastructure, with its own backups, key and runbooks, and the customer
data policy of [section 10](#10-data-access-rules-for-support-staff) (no customer rows in it, only ticket metadata).

## 16. Cost per customer estimate

All numbers are **assumptions for planning**, to be replaced with measured values after the pilot. Founder time is valued
at an assumed 1,000 rupees an hour **for planning only** (replace with the owner's real opportunity cost). No tool cost
is included except where stated.

| Phase | Hours of our time | Assumptions |
| --- | --- | --- |
| Pre-sale technical call and sizing | 3 | Two calls and the sizing check |
| Install, setup, backup and key setup (onboarding steps 1 to 6) | 8 | Includes a first Windows install that is partly a test; 4 hours if it goes cleanly |
| Training: admin 2 h + makers 4 h + users 30 min x 2 groups + preparation | 10 | Prepared once, reused |
| First app with the maker, go-live support | 12 | Can be sold separately as services |
| **One-time total** | **about 33** | About 33,000 rupees of founder time at the assumed rate |
| Months 1 to 3 (pilot / launch support), per month | 8 to 12 | Weekly calls (4 x 20 min), about 6 tickets at 45 min, one update (1.5 h) |
| Months 4 and after (AMC), per month: normal | 3 to 5 | About 3 tickets a month at 45 min, a monthly async check 15 min, one update every second month (0.75 h average), quarterly review (0.4 h average) |
| Months 4 and after: bad month | 10 to 15 | One S1 (restore, slow query, locked admin) |
| Yearly extras | 5 | Restore drill 3 h, refresher training 2 h |

Yearly steady-state cost per customer is therefore roughly 36 to 60 hours plus about 5 (extras), or 41 to 65 hours, about 41,000
to 65,000 rupees of founder time at the assumed rate. The owner can use this to test any proposed AMC price: if the AMC
does not cover about 65,000 rupees plus outside tools (a remote-support seat of $10 to $24 a month is one fifth of
that) the customer is subsidised by the founder's time. Rough capacity: a founder who gives support 12 hours a week
(about 50 hours a month) can carry at most about 8 to 10 steady-state customers if nothing else goes wrong, and **fewer than 5 while new customers
are being onboarded** at about 33 hours each.

## 17. When to hire the first support person

Hire (part-time at first, India-based) when **any two** of these hold for two consecutive months:

- Support consumes more than 40 % of the founder's working hours.
- More than 8 customers are live, or 3 are in onboarding at once.
- S1/S2 targets in [section 5](#5-response-and-resolution-targets-one-person-can-keep) missed more than once a month.
- A customer or a prospect asks for evening, Saturday or on-call cover that we would otherwise lose a deal over.
- The same questions fill more than half of the tickets even after help-centre and macro improvements (hire for training
  and documentation, not for firefighting).

Before hiring: the runbooks have been used on real incidents and corrected; macros exist; the ticket sheet or table has two
months of data; the data-access rules of section 10 are signed by the new person, with the customer's agreement. First
tasks for the hire: first-line triage using the use-case catalogue, health checks, onboarding of new customers, training
sessions, keeping the help centre accurate. Second person, not a replacement: the founder stays the escalation level for
engineering. Cost of the role is not estimated here (depends on the owner's budget and local market).
