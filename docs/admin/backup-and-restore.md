# Backup and restore

**Appbuilder has no built-in backup or restore feature.** There is no backup button, no scheduled backup, no export of
the whole installation and no restore wizard. If the database or the workspace folder is lost and you have no copy of
your own, the data is gone. You are responsible for backups, using PostgreSQL's own tools (`pg_dump`, `pg_restore`) and a
copy of the workspace folder. This page describes a procedure we ran on PostgreSQL 16 (see [The drill we ran](#the-drill-we-ran)).
A backup feature with a scripted restore drill is planned (P0 package J).

(Solution packages and CSV export exist, but they are for moving individual apps and tables, not backups. A solution
package excludes secrets, users and, for most purposes, the data rows you did not choose to include.)

## What to back up

| What | Where | Why |
| --- | --- | --- |
| The database | The PostgreSQL database you entered during setup | Schema `ab` (settings, users, sessions, environments) and `env_default` (roles, privileges, apps, table definitions, the audit log, and the rows of tables created in Appbuilder, `t_...`). One `pg_dump` covers all of it. |
| The workspace folder | `workspace/` or the folder in `APPBUILDER_WORKSPACE` | `.secret-key` (decrypts saved passwords and keys), `server.json` (database location), `files/` (copies of CSV/Excel/JSON data files) and `attachments/` if any are stored there. |
| Other databases | Any extra PostgreSQL or MySQL connection | Appbuilder does not back these up; they are your existing databases. |
| Google Sheets | Google | Use Google's version history; Appbuilder keeps nothing. |
| Environment settings | Your service definition or scheduled task | `APPBUILDER_*` variables, including `APPBUILDER_SECRET_KEY` if you use it. |

**`.secret-key` is as important as the database.** Without it, a restored database cannot be used: the saved database
password and every connection secret (for example a Google key) can no longer be decrypted. Keep it in a separate,
access-controlled place from the database dump. If you use `APPBUILDER_SECRET_KEY`, keep that value safe instead.
Anyone holding the dump *and* the key can read all saved connection secrets.

## Back up

1. **Database.** Use `pg_dump` (installed with PostgreSQL; on Windows in `C:\Program Files\PostgreSQL\17\bin`) in its
   **custom format** (`--format=custom`: compressed, restorable selectively with `pg_restore`):

   ```
   pg_dump --host=127.0.0.1 --port=5432 --username=appbuilder --format=custom --file=appbuilder-2026-01-31.dump appbuilder
   ```

   - Replace `appbuilder` (the last word) with your database name. `pg_dump` asks for the password; for a scheduled backup
     put it in a [password file](https://www.postgresql.org/docs/current/libpq-pgpass.html) (`%APPDATA%\postgresql\pgpass.conf`
     on Windows, `~/.pgpass` on Linux, readable only by that user) instead of a command line or a script.
   - `pg_dump` takes a consistent snapshot while Appbuilder keeps running; no need to stop it.
   - The `appbuilder` role owns everything Appbuilder created, so it can dump the whole database. A separate read-only backup
     role needs `CONNECT` on the database, `USAGE` on the schemas `ab` and `env_default` and `SELECT` on their tables (and on
     tables makers create later: `ALTER DEFAULT PRIVILEGES`). The superuser `postgres` works too.
   - Use a `pg_dump` of the same or a newer major version than the server.
   - One environment alone: `--schema=env_default` (plus `--schema=ab` for the users it refers to).
2. **Workspace.** Stop the server (or at least do this at a quiet moment: data files are written a moment after each
   edit) and copy the whole `workspace` folder, including the hidden `.secret-key` file.
3. **Store both off the machine.** A backup on the same disk does not survive a disk failure. Encrypt it if it leaves
   the PC (the dump contains password hashes and data).
4. **Check that it worked.** `pg_restore --list appbuilder-2026-01-31.dump` must list the schemas `ab` and `env_default` and a
   `TABLE DATA` entry per table; an error or an empty list means failure. Better: do a test restore (below). A backup you have
   never restored is not a backup.

How often is up to you: after the last change you can afford to lose. A daily dump scheduled with Windows Task Scheduler
is a sensible minimum for a live installation. Also back up before every upgrade ([Upgrades](upgrades.md)).

## Restore

Restore into an empty database; never over a running installation you want to keep.

1. Stop the Appbuilder server.
2. Create the empty database and, if needed, the role (see [Installation](installation.md#prepare-the-database);
   `scripts/setup-postgres.ps1` / `.sh` do both). If the database still exists, drop it first (as a superuser:
   `dropdb --host=127.0.0.1 --username=postgres --force appbuilder`). The database must be UTF8 and owned by the Appbuilder role:

   ```sql
   CREATE DATABASE appbuilder OWNER appbuilder ENCODING 'UTF8' TEMPLATE template0;
   ```
3. Load the dump as the Appbuilder role, so it owns what it restores (works the same in cmd, PowerShell and Linux shells):

   ```
   pg_restore --host=127.0.0.1 --port=5432 --username=appbuilder --dbname=appbuilder --no-owner --exit-on-error appbuilder-2026-01-31.dump
   ```

   `--no-owner` makes the restoring role the owner of every object, which is what you want when the role name differs on the
   new machine. The identity sequence of the audit log is restored with the data, so new entries continue the numbering.
4. Put the saved workspace folder back (with `.secret-key` and `server.json`). Start the server. Sign in. This was tested:
   with the original workspace and the same database login, the server started (schema version 4, up to date), sign-in worked,
   the rows were back, and new rows and audit entries were written.
5. **If the database login or address is different** from the one recorded in `server.json` (new machine, new user),
   stop the server, delete `workspace/server.json` (or change the `APPBUILDER_DB_*` variables), start the server and enter
   the new details on the setup screen, on this PC, with the setup code printed in the server window. Because the
   restored database already contains users, nobody becomes administrator and your accounts still work. Making the setup
   screen reachable relies on there being no `server.json` (it also holds the `setupComplete` marker that keeps the setup
   closed); see [Connections](connections.md#the-default-database).
6. **If `.secret-key` is lost**, the server reports "The saved database password cannot be decrypted (was
   workspace/.secret-key replaced?). Run the database setup again." Delete `server.json` and run the setup (with the setup
   code from the server window). A new key is
   created; users, roles and apps are intact, but **every other saved connection secret is unreadable** (for example the
   Google service-account key): open each such connection and enter the secret again.
7. Copy back `workspace/files/` data files. These are not in the dump; without them tables of those connections show
   errors.
8. Check: sign in, open an app, look at a few rows, open **Connections** and press **Test** on each.

After a restore, the *Default database* connection is rebuilt from `server.json` or the environment (it cannot be edited in
the portal).

## Test your backup

Do this once, and again after major changes. Never point a test at the production database.

1. Create a scratch database with another name (for example `createdb --owner=appbuilder appbuilder_restoretest` as a superuser)
   and load the dump into it with `pg_restore --no-owner --dbname=appbuilder_restoretest ...`.
2. Copy the workspace to another folder.
3. Start a second server on another port with the scratch values:
   `APPBUILDER_DB_NAME=appbuilder_restoretest APPBUILDER_WORKSPACE=C:\scratch\ws PORT=5199` plus the usual
   `APPBUILDER_DB_HOST`, `_USER` and `_PASSWORD` variables, then open `http://localhost:5199`.
   When `APPBUILDER_DB_*` is set the server uses it instead of `server.json`.
4. Sign in and check your data. Stop the scratch server, drop the scratch database (`dropdb --force appbuilder_restoretest`),
   delete the scratch folder.

## The drill we ran

On 18 Nov 2026, against the sandbox PostgreSQL 16.15 (port 5433, sandbox-only account `abdev`) and a server that had been through
the setup, the sample data and the documentation walkthrough (2 users, 3 tables, 2 apps, 8 contacts, 31 audit entries):

```bash
pg_dump -h 127.0.0.1 -p 5433 -U abdev -d appbuilder_test_docs -Fc -f /tmp/abbackup/appbuilder.dump    # 33,851 bytes
pg_restore -l /tmp/abbackup/appbuilder.dump      # schemas ab and env_default, 19 TABLE DATA entries
tar -C /tmp -czf /tmp/abbackup/workspace.tar.gz ws-docs                                               # the workspace folder
dropdb -h 127.0.0.1 -p 5433 -U abdev --force appbuilder_test_docs                                     # the wipe
createdb -h 127.0.0.1 -p 5433 -U abdev -E UTF8 -T template0 appbuilder_test_docs
pg_restore -h 127.0.0.1 -p 5433 -U abdev -d appbuilder_test_docs --no-owner --exit-on-error /tmp/abbackup/appbuilder.dump
```

Counts before and after were identical (users 2, table definitions 3, apps 2, contacts 8, audit entries 31). The server then
started against the restored database ("system schema version 4 (up to date)"), the administrator signed in, the Contacts query
returned 8 rows, a new row was inserted, and the audit log continued with ids 32 and 33. A scripted drill (backup, wipe, restore,
check) is part of P0 package J.

## Things that are not covered

- **Point-in-time recovery.** A dump is a snapshot. Anything after it is lost unless you set up PostgreSQL WAL archiving
  (continuous archiving) yourself.
- **Single-table or single-app restore.** Not provided. You can restore a dump into a scratch database and copy rows
  out with SQL.
- **Attachments.** Files uploaded to attachment columns are stored by Appbuilder and are not part of the database dump.
  Back up the workspace folder, and see the attachments notes in [Security model](security-model.md#attachments).
- **Audit log tamper-evidence.** The audit table is in the dump but anyone who can edit the database can edit it.
  See [Audit log](audit-log.md).
