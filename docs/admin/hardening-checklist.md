# Hardening checklist

A short list for a new installation. Details are in the other pages; read the
[Security model](security-model.md) for what Appbuilder does and does not protect against.

## Before first start

- [ ] **Use a dedicated database and user** for Appbuilder, not a shared or root account, and not a database that another
  application uses. Grant only `SELECT, INSERT, UPDATE, DELETE, CREATE, ALTER, DROP, INDEX` on that database
  ([Installation](installation.md#prepare-the-database); verified on MariaDB 10.11).
- [ ] **Keep the server on `127.0.0.1`** (the default). Do not set `APPBUILDER_HOST=0.0.0.0`: the host check can be
  defeated by a client that sends `Host: localhost`, and there is no TLS.
- [ ] **Put the workspace outside the source folder** with `APPBUILDER_WORKSPACE`, in a folder only the Windows account
  that runs Appbuilder (and administrators) can open.
- [ ] **Prefer the setup screen** over `APPBUILDER_DB_PASSWORD`: the screen stores the password encrypted, while an
  environment variable sits in plain text in your service definition.
- [ ] Make sure MySQL is running before Appbuilder starts (the server does not retry at boot; restart it if it came up
  "unconfigured").

## First run

- [ ] **Do the setup yourself, immediately.** Until the first administrator exists, whoever reaches the setup screen
  first becomes administrator, and any program on the PC can reach it.
- [ ] Choose a long, unique password (10 characters is the minimum, longer is better).
- [ ] **Create a second administrator** so one lost password does not lock you out (the last active administrator
  cannot be disabled or deleted).
- [ ] **Delete the sample data** (Contacts, Orders, Contacts app) if you do not want it.

## Accounts and roles

- [ ] One account per person; no shared logins (the audit log names users).
- [ ] Give the **Maker** and **Administrator** roles to as few people as possible. Makers can link any table in a
  connected database, bypass table privileges by re-linking, and delete tables and columns
  ([Users and roles](users-and-roles.md#what-makers-and-administrators-can-do)).
- [ ] Give everyone else Viewer or a custom role with the least access. Use **Test as user** to check what a role really
  sees before you rely on it.
- [ ] Remember that row filters and "own rows only" limit *what is seen*, not *what values a user may write*
  ([limits](users-and-roles.md#known-limits-of-row-filters)).
- [ ] Disable accounts when people leave (**Ban** button). Review the user list regularly.
- [ ] Set temporary passwords and tell users to change them; Appbuilder cannot force a change.

## Data and connections

- [ ] Use least-privilege database users for every extra MySQL connection (read-only where possible).
- [ ] Share Google spreadsheets only with the service account and the few people who need them. Keep the service-account
  key private and delete it in Google Cloud if the PC is lost.
- [ ] Treat CSV exports as sensitive; spreadsheet programs may run formulas in exported cells.

## Windows machine

- [ ] Turn on **BitLocker** (or equivalent disk encryption). Appbuilder encrypts saved secrets, but the key
  (`.secret-key`) sits beside them, so anyone who can read the workspace folder can decrypt them.
- [ ] Do not rely on file permissions set by Appbuilder: its `0600` file modes are not meaningful on Windows (untested);
  set folder permissions (ACLs) yourself.
- [ ] Lock the screen. Sessions last 7 days and the cookie is never marked `Secure`.
- [ ] Keep Windows, Node.js and MySQL up to date.

## Backups, monitoring, updates

- [ ] **Back up regularly**: there is no built-in backup. Database dump plus the workspace folder including
  `.secret-key`, stored separately and encrypted ([Backup and restore](backup-and-restore.md)). Do a test restore.
- [ ] **Review the audit log** weekly for user, role and connection changes and for failed sign-ins
  ([Audit log](audit-log.md)); it is only readable through SQL, and it is not tamper-proof.
- [ ] **Update** when new versions appear, after a backup ([Upgrades](upgrades.md)).
- [ ] Know where the server's console output goes; errors and the one-time migration summary appear only there.
- [ ] Do not expose the server to the internet or a shared network, not even through a port forward or tunnel, until
  TLS and the weaknesses listed in [Security model](security-model.md#explicit-limitations) are dealt with.
