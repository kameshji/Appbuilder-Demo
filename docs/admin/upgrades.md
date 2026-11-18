# Upgrades

Appbuilder is installed from its source folder, so an upgrade means getting newer source, rebuilding and restarting.
There is no installer, no automatic update and no release channel yet. Read `CHANGELOG.md` (and the commit
history) of what you pull before you apply it.

## Before you upgrade

1. **Back up**: Admin console > Backups > Back up now (whole install), and download it or check the off-site copy
   ([Backup and restore](backup-and-restore.md)). The server also takes an install backup by itself before it changes the
   database schema (below), but a backup you made and moved off the machine is the reliable way back: an older version
   refuses a database a newer one has upgraded.
2. **Keep the workspace outside the source folder.** The default `workspace/` folder is inside the repository. It is
   ignored by version control, but commands such as `git clean -x` or deleting and re-cloning the folder would delete it,
   including `.secret-key`. Set `APPBUILDER_WORKSPACE` to a folder elsewhere (for example `C:\AppbuilderData\workspace`)
   and move the existing folder there while the server is stopped.
3. Tell users, then stop the server (close its console window or stop the scheduled task).

## Upgrade steps

Run these in the Appbuilder folder (Node 22.18 or newer; see [Installation](installation.md#requirements)):

```
git pull --ff-only
npm ci
npm run build
```

Then start the server as usual (`start.ps1`, or your scheduled task). `--ff-only` stops with an error instead of merging
if you have local changes; resolve that before going on. `npm ci` installs exactly the versions in `package-lock.json`.
`npm run build` compiles the web interface (`tsc -b && vite build`); the server itself runs the TypeScript files
directly and is not built.

On a PC set up with `scripts/setup-offline.ps1`, running that script again also updates the installation. Check its
output: it currently only checks for Node 20 or newer (the real requirement is 22.18), and it assumes port 5174.

After start, sign in and check an app, **Connections > Test**, and the console for errors.

## What happens to the database

On every start the server runs its schema step (`migrate()` in `server/core/meta-store.ts`) in two phases:

1. It reads `schemaVersion` from `ab.settings` (downgrade guard below), then, in **one transaction** (PostgreSQL DDL is
   transactional, so a failed step leaves the database as it was), creates or completes schema `ab`, runs the install-level
   upgrade steps the database has not had yet, in order, and records the new `schemaVersion`.
2. Then **each environment** schema (`env_<id>`), in **its own transaction**: it reads that environment's `schema_version`
   (`ab.environments`), refuses one that a newer server migrated (downgrade guard per environment), completes its tables,
   runs its upgrade steps and records its version. An environment whose step fails is marked **Failed** with the reason
   (`ERROR ENVIRONMENT <id> NOT AVAILABLE` on the console, `environment.migrate_failed` in the install audit log); the
   others, and the server, keep working. The next start tries it again. See [Environments](environments.md#when-an-environment-is-not-available).

Current version: **7**.

**Before the first step** of an upgrade that changes the schema (the database is at version 4 or later but below the
server's), the server writes an **install backup** of the database as it is into the backup folder (trigger "Before a
server upgrade"; [Backup and restore](backup-and-restore.md#automatic-backups-before-risky-changes)). If that backup fails,
the server does **not** upgrade the database: it logs `DATABASE NOT UPGRADED: the backup before the schema upgrade failed`,
data routes answer 503 with the reason, and it does not retry. Fix the cause (disk space, the backup folder), or start once
with `APPBUILDER_MIGRATION_BACKUP=skip` to upgrade without it. Switch it off in Admin console > Backups > Settings.

| Version | Step |
| --- | --- |
| 1 to 3 | The MySQL/MariaDB system store of versions 0.1 to 0.4. **There is no upgrade from MySQL** (decision D14): a PostgreSQL database never has these versions, and a 0.5 server pointed at an old MySQL database cannot connect to it at all. |
| 4 | The PostgreSQL layout: schema `ab` (settings, users, sessions, environments, licence) and the environment schema `env_default` (see [schema](../dev/schema.md)). |
| 5 | Real environments: `ab.environments` gets state, schema version, lock, description, creator; new tables `ab.environment_access` (who may enter which environment) and `ab.audit` (install-level audit); `ab.users` gets `is_install_admin` and `last_environment_id`. Data: every user who held an Administrator role becomes an **install administrator**; every user keeps access to Default (environment administrators: the Administrator role holders). Files: `workspace/attachments/` and `workspace/files/` move into `workspace/env/default/` (only what is not there yet; nothing is overwritten or deleted). |
| 6 | P0 wave 3: organisation (`ab.departments`, `ab.teams`, `ab.team_members`, new user fields), in-app notifications (`ab.notifications`, `ab.user_settings`); in every environment record sharing (`ab_shares`) and the event and job kernel (`ab_outbox`, `ab_jobs`, `ab_schedules`, `ab_table_events`, `ab_event_runs`). Only new tables and columns: nothing existing changes. After the upgrade the built-in maintenance schedules appear on the Jobs page of each environment. A version 5 server refuses a version 6 database. |
| 7 (backups) | The backup catalogue in schema `ab` (`ab.backups`, `ab.backup_ops`; package J). Only new tables. After the upgrade a nightly install backup at 02:00 (server time) is scheduled; the first start writes an install backup before migrating. |

- **Moving from 0.4 (MySQL) to 0.5 (PostgreSQL).** Since there are no customer installations yet, there is no conversion. Install
  PostgreSQL ([Installation](installation.md#prepare-the-database)), point the new version at an empty database and start fresh.
  To carry apps and tables over, export them as **solution packages with data** from the 0.4 installation first and import them
  into the new one ([Solutions](../guide/maker/solutions.md)); users and roles have to be created again.
- **The migration summary** (from which version to which, and what each step did) is printed to the server console at
  start and written to the audit log of Default and the install-level audit log as `schema.migrate` (details:
  `{ from, to, steps, environments }`). An up-to-date database prints "system schema version 6 (up to date)" and writes nothing.
- The data tables (`t_...` in each `env_<id>`) are yours and are not touched by upgrades. (Linked tables are touched only when a
  maker agrees to add system columns while linking, see [Connections](connections.md).)
- The schema step needs the Appbuilder role to own the database (or have `CREATE` on it), as set up by
  `scripts/setup-postgres.*` ([Installation](installation.md#prepare-the-database)).

### Running an older version against a newer database

The server refuses a database whose `schemaVersion` is **higher** than the version it knows (downgrade guard). It does
not run any statement against it (not even `CREATE TABLE IF NOT EXISTS`), prints

```
ERROR DATABASE NOT USED: The database schema is version 6, but this Appbuilder only knows version 5. ...
```

and stays up without a database: every data route answers 503, `GET /api/v1/status` reports `setup.incompatible: true`,
the browser shows "This database needs a newer Appbuilder", and the setup screen cannot be used to point it elsewhere.
It does not retry. Start the newer version again, or restore the pre-upgrade backup into the database before starting
the old code.

## Solution upgrades in an environment

Not the Appbuilder upgrade, but the one makers and administrators do every day: importing or deploying a newer version of a
solution into an environment where it already exists **upgrades it in place** (same apps, tables and roles; data kept), after a
plan that lists every new, changed and removed app, table, column and role, with destructive changes (a dropped table or
column loses its data) in red. The whole upgrade runs in one transaction: if any step fails (for example a value that does not
convert to a column's new type), nothing changes. See [Solutions](../guide/maker/solutions.md#deploy-to-another-environment).

Before it changes anything, the upgrade takes a **backup of the target environment** (the plan says "A backup of this
environment is taken before anything changes"; the result names the backup). If that backup fails, nothing changes: the
dialog explains why and offers **Upgrade without a backup** or Cancel. With automatic backups switched off (Admin console >
Backups > Settings) the plan says so in amber and no backup is taken. To undo an upgrade, restore that backup in place
or as a new environment ([Backup and restore](backup-and-restore.md#restore)).

## Roll back

If the new version misbehaves:

1. Stop the server.
2. In the source folder, return to the previous commit you noted before upgrading (`git checkout <commit>`; note it
   with `git rev-parse HEAD` before you pull), then `npm ci` and `npm run build`.
3. If the new version had run (and might have changed the database), restore the install backup taken before the upgrade
   (yours, or the automatic one, "Before a server upgrade", in the backup folder) onto an emptied database with
   `node server/main.ts restore <archive> --force` ([Disaster recovery](disaster-recovery.md)).
   Rolling back the code alone does not work once the new version upgraded the schema: the old code refuses the newer
   database (downgrade guard above). Restore the dump.
4. Start the server.

## Migrating an older file-based workspace

Early versions (phase 2) kept data in files: `workspace.yaml`, `tables/*.schema.yaml` and `apps/*.app.yaml` in the
workspace folder, and CSV data. The current version stores everything in PostgreSQL. A conversion exists, but it runs only
**once, at the moment the first administrator is created on the setup screen**, and only if those files are found in
the workspace folder.

What it does (tested with a sample old workspace):

- Tables become tables on the built-in **Data files** connection (so they stay on this PC and are not in the database;
  use *Move to database* afterwards if you want that).
- Roles are merged by name with the built-in roles. Users are created **without passwords**: an administrator must set a
  password for each ([Users and roles](users-and-roles.md#create-a-user)).
- Apps are brought over.
- Old files are **moved** to `workspace/legacy-phase2` (or `-2`, `-3` if that exists). Nothing is deleted.
- A summary of what was converted is written **only to the server's console**, so keep that window open or copy the
  text. If the conversion fails, the error is logged and setup carries on with an empty system (the sample data), and
  your old files stay in place.

Because it only runs at first-administrator creation, you cannot run it again later on a running system. To retry:
restore or recreate the old files in a clean workspace, drop and recreate the database (or use a new one) and run the
setup again.
If no old files are found, the setup instead creates sample data: two tables (Contacts, Orders) and a "Contacts app".
Delete them if you do not want them.

## Not supported yet

- Automatic or one-click updates, signed releases, a release notes file.
- Re-running the legacy conversion on a live system.
- Zero-downtime upgrades: the server must be restarted, which ends nothing permanently (sessions live in the database)
  but briefly interrupts users. In-memory login throttle counters are reset by a restart.
