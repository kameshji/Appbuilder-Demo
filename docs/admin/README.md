# Administrator guide

This guide is for the person who installs and runs Appbuilder on a PC: it covers installation, users and roles,
connections, backups, upgrades and security. ("Appbuilder" is a working name.)

Everything here describes **server mode**: the local Node server with a PostgreSQL database and real sign-in.
The browser-only demo mode has no server, no real security and is not covered (see
[Security model](security-model.md#demo-mode-is-not-secure)).

## Pages

| Page | Read it when |
| --- | --- |
| [Installation](installation.md) | You are setting Appbuilder up for the first time (the Windows and Linux installers, offline bundles, HTTPS), or moving it to another machine |
| [Operations](operations.md) | You run it day to day: services, where files live, logs, health, the diagnostics bundle for support, usage |
| [Users and roles](users-and-roles.md) | You add people, decide who can build, and control which rows and columns each person sees |
| [Sign-in and identity](sign-in-and-identity.md) | You set up email, two-step verification, password and session rules, invitations, reset codes, service accounts and API keys |
| [Organisation](organisation.md) | You set up departments, managers and teams, import people from a CSV file, or look at the org chart |
| [Reference data, number sequences and the financial year](reference-data.md) | You maintain currencies, Indian states and GST codes, units, holidays and settings, set up invoice numbering, or change the financial year |
| [Accounts](accounts.md) | You set up ledgers and GST documents: the business registration, GST reference data (rates, States, thresholds), who may use Accounts, period locks |
| [Environments](environments.md) | You want a sandbox next to production, move solutions between them, lock production, or give people access to an environment |
| [Connections](connections.md) | You change the database, link existing PostgreSQL or MySQL tables, use data files or Google Sheets, add HTTP and Email connections for flows, decide who may use them, set email limits and the suppression list |
| [Approvals](approvals.md) | Who sees approval requests, email answer links, delegation for others, escalation, audit and retention |
| [Flows](flows.md) | You decide who may build, run and change flows, which identity they run as, pause every flow at once (kill switch), and keep their run history |
| [Webhook security](webhook-security.md) | Another system (Tally, a payment provider, a form tool) should start a flow by calling Appbuilder |
| [Backup and restore](backup-and-restore.md) | You need to protect the data, or recover it |
| [Disaster recovery](disaster-recovery.md) | The machine or the database is gone and you have a backup |
| [Upgrades](upgrades.md) | You are installing a newer version (the updater, Admin console > Updates, rolling back) |
| [Audit log](audit-log.md) | You need to know who did what |
| [Jobs](jobs.md) | You check background work, retry failed jobs, change retention, or read the events run log |
| [Security model](security-model.md) | You are evaluating Appbuilder, or need to know exactly what is and is not protected |
| [Hardening checklist](hardening-checklist.md) | You are about to let real people use it with real data |

## What you need to know first

- **One machine, HTTPS in front for others.** The server listens on `127.0.0.1` only. Other PCs reach it through the
  HTTPS reverse proxy (Caddy) the installers set up on request, for the local network or a domain name
  ([Installation](installation.md#which-way-users-reach-it)). Changing the listening address itself makes the server less
  safe, not more usable ([Installation](installation.md#changing-the-listening-address-is-not-supported)).
- **Two things hold your data.** The PostgreSQL database, and the *workspace folder* (data files, attachments, the
  encryption key and the saved database login). Admin console > Backups backs up both, nightly by default, and restores
  an environment, tables or the whole install ([Backup and restore](backup-and-restore.md)). Keep copies off the machine,
  and keep the encryption key apart from them.
- **Environments.** Default (production) plus up to four more (sandbox, developer), each with its own tables, apps, roles
  and files. Accounts are shared; install administrators manage environments and accounts, environment administrators
  their environment. See [Environments](environments.md).
- **Three built-in roles** in every environment. Administrator, Maker and Viewer. Anything finer is a role you create.
- **Only some things are logged.** Changes are written to the `ab_audit` table. Reading data is not logged, and there is
  no screen to view the log yet: you query it with SQL.

## Not supported yet

These are missing in this version and are listed again, with detail, where they matter:

- Single sign-on, and any rate limit other than the sign-in throttles.
- A screen for the audit log, and automatic deletion of old audit entries.
- Automatic downloads of updates: you bring the release file to `appbuilder update` ([Upgrades](upgrades.md)).
- Version-compatibility checks when going back to an older version.

Everything in these pages was checked against the code in `server/` and the tests next to it. Where a statement could
only be read from the code, and not confirmed by a test or by running the server, the page says so.
