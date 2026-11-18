# Backup and restore

**Appbuilder has no built-in backup or restore feature.** There is no backup button, no scheduled backup, no export of
the whole installation and no restore wizard. If the database or the workspace folder is lost and you have no copy of
your own, the data is gone. You are responsible for backups, using the database's own tools and a copy of the workspace
folder. This page describes a procedure we tested on MariaDB 10.11.

(Solution packages and CSV export exist, but they are for moving individual apps and tables, not backups. A solution
package excludes secrets, users and, for most purposes, the data rows you did not choose to include.)

## What to back up

| What | Where | Why |
| --- | --- | --- |
| The database | The MySQL/MariaDB database you entered during setup | Users, roles, privileges, apps, table definitions, the audit log and the rows of tables created in Appbuilder (`t_...` tables) all live here. One dump covers all of it. |
| The workspace folder | `workspace/` or the folder in `APPBUILDER_WORKSPACE` | `.secret-key` (decrypts saved passwords and keys), `server.json` (database location), `files/` (copies of CSV/Excel/JSON data files) and `attachments/` if any are stored there. |
| Other databases | Any extra MySQL connection | Appbuilder does not back these up; they are your existing databases. |
| Google Sheets | Google | Use Google's version history; Appbuilder keeps nothing. |
| Environment settings | Your service definition or scheduled task | `APPBUILDER_*` variables, including `APPBUILDER_SECRET_KEY` if you use it. |

**`.secret-key` is as important as the database.** Without it, a restored database cannot be used: the saved database
password and every connection secret (for example a Google key) can no longer be decrypted. Keep it in a separate,
access-controlled place from the database dump. If you use `APPBUILDER_SECRET_KEY`, keep that value safe instead.
Anyone holding the dump *and* the key can read all saved connection secrets.

## Back up

1. **Database.** Use `mysqldump`, which is installed with MySQL/MariaDB:

   ```
   mysqldump --host=127.0.0.1 --user=BACKUP_USER --password --single-transaction --default-character-set=utf8mb4 --no-tablespaces --result-file=appbuilder-2026-01-31.sql appbuilder
   ```

   - Replace `appbuilder` with your database name. `--password` with no value asks for it, which keeps it out of
     history and process lists.
   - **On Windows PowerShell use `--result-file=...` as shown. Do not use `> file.sql`**: PowerShell writes redirected
     text as UTF-16 and the file cannot be restored.
   - `--single-transaction` gives a consistent copy without stopping Appbuilder (for InnoDB tables, which Appbuilder
     creates).
   - The backup user needs `SELECT`, `SHOW VIEW`, `TRIGGER` on the database (and `LOCK TABLES` unless you use
     `--single-transaction`). It does not need write access.
   - Tables Appbuilder did not create may use other storage engines; check them if you linked such tables.
2. **Workspace.** Stop the server (or at least do this at a quiet moment: data files are written a moment after each
   edit) and copy the whole `workspace` folder, including the hidden `.secret-key` file.
3. **Store both off the machine.** A backup on the same disk does not survive a disk failure. Encrypt it if it leaves
   the PC (the dump contains password hashes and data).
4. **Check that it worked.** Open the `.sql` file size; an empty or tiny file means failure. Better: do a test restore
   (below). A backup you have never restored is not a backup.

How often is up to you: after the last change you can afford to lose. A daily dump scheduled with Windows Task Scheduler
is a sensible minimum for a live installation. Also back up before every upgrade ([Upgrades](upgrades.md)).

## Restore

Restore into an empty database; never over a running installation you want to keep.

1. Stop the Appbuilder server.
2. Create the empty database and, if needed, a user (see [Installation](installation.md#prepare-the-database)). Use
   character set `utf8mb4` and collation `utf8mb4_unicode_ci`:

   ```sql
   CREATE DATABASE appbuilder CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
   ```
3. Load the dump. In **cmd** or Linux shells:
   `mysql --host=127.0.0.1 --user=ADMIN_USER --password appbuilder < appbuilder-2026-01-31.sql`.
   PowerShell has no `<` operator, so there use
   `mysql --host=127.0.0.1 --user=ADMIN_USER --password --execute="source C:/backups/appbuilder-2026-01-31.sql" appbuilder`
   (forward slashes in the path).
4. Put the saved workspace folder back (with `.secret-key` and `server.json`). Start the server. Sign in. This was tested:
   with the original workspace and the same database login, the server started and sign-in worked.
5. **If the database login or address is different** from the one recorded in `server.json` (new machine, new user),
   stop the server, delete `workspace/server.json` (or change the `APPBUILDER_DB_*` variables), start the server and enter
   the new details on the setup screen. Because the restored database already contains users, nobody becomes
   administrator and your accounts still work. Making the setup screen reachable relies on there being no `server.json`;
   see [Connections](connections.md#the-default-database).
6. **If `.secret-key` is lost**, the server reports "The saved database password cannot be decrypted (was
   workspace/.secret-key replaced?). Run the database setup again." Delete `server.json` and run the setup. A new key is
   created; users, roles and apps are intact, but **every other saved connection secret is unreadable** (for example the
   Google service-account key): open each such connection and enter the secret again.
7. Copy back `workspace/files/` data files. These are not in the dump; without them tables of those connections show
   errors.
8. Check: sign in, open an app, look at a few rows, open **Connections** and press **Test** on each.

After a restore, the *Default database* connection is rebuilt from `server.json` or the environment, so any manual edits to
it are gone.

## Test your backup

Do this once, and again after major changes. Never point a test at the production database.

1. Create a scratch database with another name (for example `appbuilder_restoretest`) and load the dump into it.
2. Copy the workspace to another folder.
3. Start a second server on another port with the scratch values:
   `APPBUILDER_DB_NAME=appbuilder_restoretest APPBUILDER_WORKSPACE=C:\scratch\ws PORT=5199` plus the usual
   `APPBUILDER_DB_HOST`, `_USER` and `_PASSWORD` variables, then open `http://localhost:5199`.
   When `APPBUILDER_DB_*` is set the server uses it instead of `server.json`.
4. Sign in and check your data. Stop the scratch server, drop the scratch database, delete the scratch folder.

## Things that are not covered

- **Point-in-time recovery.** A dump is a snapshot. Anything after it is lost unless you enable MySQL binary logs yourself.
- **Single-table or single-app restore.** Not provided. You can restore a dump into a scratch database and copy rows
  out with SQL.
- **Attachments.** Files uploaded to attachment columns are stored by Appbuilder and are not part of the database dump.
  Back up the workspace folder, and see the attachments notes in [Security model](security-model.md#attachments).
- **Audit log tamper-evidence.** The audit table is in the dump but anyone who can edit the database can edit it.
  See [Audit log](audit-log.md).
