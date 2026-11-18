# Administrator guide

This guide is for the person who installs and runs Appbuilder on a PC: it covers installation, users and roles,
connections, backups, upgrades and security. ("Appbuilder" is a working name.)

Everything here describes **server mode**: the local Node server with a PostgreSQL database and real sign-in.
The browser-only demo mode has no server, no real security and is not covered (see
[Security model](security-model.md#demo-mode-is-not-secure)).

## Pages

| Page | Read it when |
| --- | --- |
| [Installation](installation.md) | You are setting Appbuilder up for the first time, or moving it to another PC |
| [Users and roles](users-and-roles.md) | You add people, decide who can build, and control which rows and columns each person sees |
| [Environments](environments.md) | You want a sandbox next to production, move solutions between them, lock production, or give people access to an environment |
| [Connections](connections.md) | You change the database, link existing PostgreSQL or MySQL tables, use data files or Google Sheets |
| [Backup and restore](backup-and-restore.md) | You need to protect the data, or recover it |
| [Upgrades](upgrades.md) | You are installing a newer version |
| [Audit log](audit-log.md) | You need to know who did what |
| [Security model](security-model.md) | You are evaluating Appbuilder, or need to know exactly what is and is not protected |
| [Hardening checklist](hardening-checklist.md) | You are about to let real people use it with real data |

## What you need to know first

- **One PC.** The server listens on `127.0.0.1` (this PC only). People use it from a browser on that PC, for example
  over Remote Desktop. Serving other PCs on your network is **not supported**, and changing the listening address makes
  the server less safe, not more usable. See [Installation](installation.md#changing-the-listening-address-is-not-supported).
- **Two things hold your data.** The PostgreSQL database, and the *workspace folder* (data files, attachments, the
  encryption key and the saved database login). You must back up both. There is **no built-in backup feature yet**.
- **Environments.** Default (production) plus up to four more (sandbox, developer), each with its own tables, apps, roles
  and files. Accounts are shared; install administrators manage environments and accounts, environment administrators
  their environment. See [Environments](environments.md).
- **Three built-in roles** in every environment. Administrator, Maker and Viewer. Anything finer is a role you create.
- **Only some things are logged.** Changes are written to the `ab_audit` table. Reading data is not logged, and there is
  no screen to view the log yet: you query it with SQL.

## Not supported yet

These are missing in this version and are listed again, with detail, where they matter:

- Backup and restore inside the product (use the manual steps in [Backup and restore](backup-and-restore.md)).
- TLS/HTTPS, multi-factor sign-in, single sign-on, password reset by email, and any rate limit other than the login
  throttle.
- Serving other computers on a network.
- A screen for the audit log, and automatic deletion of old audit entries.
- Automatic updates. Updating is a manual procedure ([Upgrades](upgrades.md)).
- Version-compatibility checks when going back to an older version.

Everything in these pages was checked against the code in `server/` and the tests next to it. Where a statement could
only be read from the code, and not confirmed by a test or by running the server, the page says so.
