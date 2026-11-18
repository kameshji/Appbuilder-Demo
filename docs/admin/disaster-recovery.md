# Disaster recovery

The runbook for when the machine, the disk or the database is gone and you have an **install backup** (an `.abbak` file
from Admin console > Backups, its off-site copy, or a download). For everyday restores (one environment, some tables)
use the Admin console: [Backup and restore](backup-and-restore.md#restore).

Have ready: the **archive**; its **passphrase** if it is encrypted; the install's **encryption key** (`.secret-key`, or the
value of `APPBUILDER_SECRET_KEY`) unless the backup includes it; the database password you want to use.

## 1. A machine with Appbuilder and PostgreSQL

Install as for a new install ([Installation](installation.md)): Node.js, PostgreSQL (the same major version as before or
newer), the Appbuilder source **of the same version as the backup or newer** (a newer one upgrades the restored database;
an older one refuses it), `npm ci` and `npm run build`. Create an **empty** database and its owner role
(`scripts/setup-postgres.ps1` or `.sh`). Do **not** run the setup screen.

## 2. Restore

In the Appbuilder folder, with the database login in the environment (PowerShell: `$env:APPBUILDER_DB_PASSWORD = '...'`):

```
node server/main.ts restore D:\Restore\appbuilder-install-20261118-020000Z-a1b2c3.abbak --workspace C:\AppbuilderData\workspace ^
  --db-host 127.0.0.1 --db-port 5432 --db-name appbuilder --db-user appbuilder
```

(Linux: `\` instead of `^`.) Without `--db-*` it uses `APPBUILDER_DB_*`, else the workspace's `server.json`. Options:
`--passphrase-file <file>` (else `APPBUILDER_BACKUP_PASSPHRASE`, else it asks), `--key-file <.secret-key kept apart>`,
`--check` (only check the archive), `--force` (replace Appbuilder schemas already in the database and environment
folders already in the workspace), `--yes` (no question).

What it does, in order, printing each step:

1. Opens the archive and refuses a backup from a **newer** Appbuilder or of a single environment.
2. **Checks** it completely: every file against its checksum, every table's rows counted again. A damaged or altered
   archive stops here; nothing has been changed.
3. Refuses a database that already holds Appbuilder schemas (`ab`, `env_*`) or a workspace that already has environment
   folders, unless `--force`.
4. Restores schema `ab` and every environment in **one transaction** (a failure leaves the database as it was).
5. Writes every environment's attachments and data files into the workspace, checking each against its checksum.
6. The **key**: the `--key-file`, else the key in the archive, is written to `workspace/.secret-key` (an existing
   different key is only replaced with `--force`); with `APPBUILDER_SECRET_KEY` set, that is used. Without any, a new key
   is created.
7. Writes `server.json` (the database connection, its password sealed, setup marked complete).
8. Reports how many saved secrets the key can still decrypt.
9. Runs the normal **migration**: a backup of an older version is brought to this one.

## 3. Start and check

Start the server (`start.ps1`, the service, or `npm start`). Sign in with an account from the backup (everybody signs in
again: sessions are not in backups). Check: Admin console > Environments (all there, none Failed), an app or two, a
table's row count, an attachment, **Connections > Test** on each, Admin console > Email > send a test. Then make a new
backup and check that the nightly schedule is on (Admin console > Backups).

## Without the encryption key

If the backup has no key and `.secret-key` was lost too:

| Comes back | Lost (must be entered again) |
| --- | --- |
| All data: every environment's tables and rows, attachments, data files; apps, roles, solutions, connections (their settings); users with their passwords; organisation; the audit logs; settings | Passwords and keys of **connections to other systems** (Connections: open each and enter it again; the default database is set from `server.json` and works), the **mail server password** (Admin console > Email), **two-step verification** secrets (affected people set up their authenticator again; an administrator resets it), the **saved backup passphrase** (save it again; old encrypted archives still open with the passphrase itself) |

The restore command prints "Saved secrets that this key cannot decrypt: N of M" so you know how much there is to redo.

## When something goes wrong

- *"This backup was made by a newer Appbuilder"*: install that version (or newer) and restore again.
- *"The passphrase is wrong, or the backup file was changed"*: the passphrase is wrong, or the file is damaged; try the
  off-site copy.
- *"The archive is damaged or was changed"* with a file name: that copy is damaged; use another copy (off-site, an older
  backup).
- *"The database already holds Appbuilder schemas"*: you are pointing at a database in use. Use an empty one, or add
  `--force` only if you mean to replace it.
- *"…needs pg_restore"*: the backup was made with pg_dump; install the PostgreSQL client tools of the same or a newer
  version and put them on the `PATH` (or set `APPBUILDER_PG_BIN`).
- The server says *ENVIRONMENT <id> NOT AVAILABLE* after the restore: that environment's migration failed; the reason is
  in the console and in Admin console > Environments. The others work.

## Practise it

`node scripts/drill/restore-drill.mjs` does all of the above against a scratch database and folder and compares every row
and attachment ([Restore drill](backup-and-restore.md#restore-drill)). Run your own drill on a spare machine once a year
and after big changes.
