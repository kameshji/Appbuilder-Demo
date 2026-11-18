# Hardening checklist

A short list for a new installation. Details are in the other pages; read the
[Security model](security-model.md) for what Appbuilder does and does not protect against.

## Before first start

- [ ] **Use a dedicated database and user** for Appbuilder, not a shared or root account, and not a database that another
  application uses. Grant only `SELECT, INSERT, UPDATE, DELETE, CREATE, ALTER, DROP, INDEX` on that database
  ([Installation](installation.md#prepare-the-database); verified on MariaDB 10.11).
- [ ] **Keep the server on `127.0.0.1`** (the default). Do not set `APPBUILDER_HOST=0.0.0.0`: the Host header check can
  be passed by a client that sends `Host: localhost`, so other computers reach the sign-in page and the API, and there is
  no TLS. (The first-run setup is safe from them: it checks the real connection address and needs the setup code.)
- [ ] If users reach Appbuilder through **your own HTTPS reverse proxy**, set `APPBUILDER_SECURE_COOKIE=1` (or
  `APPBUILDER_TRUST_PROXY=1` when the proxy sends `X-Forwarded-Proto: https`) so the session cookie is marked `Secure`,
  and list the proxy's host name in `APPBUILDER_ALLOWED_HOSTS` ([Installation](installation.md#environment-variables)).
- [ ] **Put the workspace outside the source folder** with `APPBUILDER_WORKSPACE`, in a folder only the Windows account
  that runs Appbuilder (and administrators) can open.
- [ ] **Prefer the setup screen** over `APPBUILDER_DB_PASSWORD`: the screen stores the password encrypted, while an
  environment variable sits in plain text in your service definition.
- [ ] Prefer MySQL running before Appbuilder starts. If it is not, the server retries in the background (up to every
  30 s) and shows "The database is not reachable" meanwhile; no restart is needed.

## First run

- [ ] **Do the setup yourself, immediately**, on the server PC, with the setup code printed in the server window. Until
  the first administrator exists, anyone at this PC who can read that window (or the log file it is redirected to) can
  become administrator. Keep the log file private.
- [ ] Choose a long, unique password (10 characters is the minimum, longer is better).
- [ ] **Create a second administrator** so one lost password does not lock you out (the last active administrator
  cannot be disabled or deleted).
- [ ] **Delete the sample data** (Contacts, Orders, Contacts app) if you do not want it.

## Accounts and roles

- [ ] One account per person; no shared logins (the audit log names users).
- [ ] Give the **Maker** and **Administrator** roles to as few people as possible. Makers can list and link any table
  in a connected database that is not linked yet, and drop tables and columns that Appbuilder created (linked tables are
  never dropped) ([Users and roles](users-and-roles.md#what-makers-and-administrators-can-do)).
- [ ] **Do not share the Appbuilder database with other applications**: every maker can see their tables' structure and
  link them. Use a separate database (or a database user that sees only what makers may see) for each extra connection.
- [ ] Give everyone else Viewer or a custom role with the least access. Use **Test as user** to check what a role really
  sees before you rely on it.
- [ ] Remember that row filters and "own rows only" limit *what is seen*, not *what values a user may write*
  ([limits](users-and-roles.md#known-limits-of-row-filters)).
- [ ] Disable accounts when people leave (**Ban** button). Review the user list regularly.
- [ ] Passwords you set for users are temporary: Appbuilder makes them choose their own at the next sign-in. Hand them
  over by a different channel than the email address.
- [ ] After linking tables that existed before, use **Assign to me** (table settings) if roles with *Own* scope must see
  the old rows; otherwise those rows have no owner.

## Data and connections

- [ ] Use least-privilege database users for every extra MySQL connection (read-only where possible).
- [ ] Share Google spreadsheets only with the service account and the few people who need them. Keep the service-account
  key private and delete it in Google Cloud if the PC is lost.
- [ ] Treat CSV exports as sensitive. Text cells that a spreadsheet could run as formulas (starting with `=`, `+`, `-`,
  `@`, tab or carriage return) are exported with a leading `'`; files imported from elsewhere are not checked.

## Windows machine

- [ ] Turn on **BitLocker** (or equivalent disk encryption). Appbuilder encrypts saved secrets, but the key
  (`.secret-key`) sits beside them, so anyone who can read the workspace folder can decrypt them.
- [ ] Do not rely on file permissions set by Appbuilder: its `0600` file modes are not meaningful on Windows (untested);
  set folder permissions (ACLs) yourself.
- [ ] Lock the screen. Sessions last 7 days. The cookie is marked `Secure` only over TLS or with
  `APPBUILDER_SECURE_COOKIE` / `APPBUILDER_TRUST_PROXY` (the built-in server speaks plain HTTP on loopback).
- [ ] Keep Windows, Node.js and MySQL up to date.

## Backups, monitoring, updates

- [ ] **Back up regularly**: there is no built-in backup. Database dump plus the workspace folder including
  `.secret-key`, stored separately and encrypted ([Backup and restore](backup-and-restore.md)). Do a test restore.
- [ ] **Review the audit log** weekly for user, role and connection changes, failed sign-ins and rejected setup codes
  ([Audit log](audit-log.md)); it is only readable through SQL, and it is not tamper-proof.
- [ ] Watch the server console for `ERROR audit write failed` lines (an entry was lost) and for `DATABASE NOT USED`
  (an older Appbuilder was started against a newer database).
- [ ] **Update** when new versions appear, after a backup ([Upgrades](upgrades.md)).
- [ ] Know where the server's console output goes: the setup code, errors and the migration summary appear there (the
  migration summary is also in the audit log as `schema.migrate`).
- [ ] Do not expose the server to the internet or a shared network, not even through a port forward or tunnel, until
  TLS and the weaknesses listed in [Security model](security-model.md#explicit-limitations) are dealt with.
