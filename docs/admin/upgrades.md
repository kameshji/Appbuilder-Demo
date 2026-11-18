# Upgrades

Appbuilder is installed from its source folder, so an upgrade means getting newer source, rebuilding and restarting.
There is no installer, no automatic update and no release channel yet. Read `CHANGELOG.md` (and the commit
history) of what you pull before you apply it.

## Before you upgrade

1. **Back up** the database and the workspace folder ([Backup and restore](backup-and-restore.md)). This matters more
   than usual: there is **no downgrade guard** (see below), so the only reliable way back is a restore.
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

On every start the server runs its schema step (`migrate()` in `server/core/meta-store.ts`): it reads `schemaVersion` from
`ab.settings`, then, in **one transaction** (PostgreSQL DDL is transactional, so a failed step leaves the database as it was),
creates or completes schema `ab` and every environment schema (`CREATE ... IF NOT EXISTS`), runs the upgrade steps the database has
not had yet, in order, and records the new `schemaVersion`. Current version: **4**.

| Version | Step |
| --- | --- |
| 1 to 3 | The MySQL/MariaDB system store of versions 0.1 to 0.4. **There is no upgrade from MySQL** (decision D14): a PostgreSQL database never has these versions, and a 0.5 server pointed at an old MySQL database cannot connect to it at all. |
| 4 | The PostgreSQL layout: schema `ab` (settings, users, sessions, environments, licence) and the environment schema `env_default` (see [schema](../dev/schema.md)). |

- **Moving from 0.4 (MySQL) to 0.5 (PostgreSQL).** Since there are no customer installations yet, there is no conversion. Install
  PostgreSQL ([Installation](installation.md#prepare-the-database)), point the new version at an empty database and start fresh.
  To carry apps and tables over, export them as **solution packages with data** from the 0.4 installation first and import them
  into the new one ([Solutions](../guide/maker/solutions.md)); users and roles have to be created again.
- **The migration summary** (from which version to which, and what each step did) is printed to the server console at
  start and written to the audit log as `schema.migrate` (details: `{ from, to, steps }`). An up-to-date database prints
  "system schema version 4 (up to date)" and writes nothing.
- The data tables (`t_...` in `env_default`) are yours and are not touched by upgrades. (Linked tables are touched only when a
  maker agrees to add system columns while linking, see [Connections](connections.md).)
- The schema step needs the Appbuilder role to own the database (or have `CREATE` on it), as set up by
  `scripts/setup-postgres.*` ([Installation](installation.md#prepare-the-database)).

### Running an older version against a newer database

The server refuses a database whose `schemaVersion` is **higher** than the version it knows (downgrade guard). It does
not run any statement against it (not even `CREATE TABLE IF NOT EXISTS`), prints

```
ERROR DATABASE NOT USED: The database schema is version 5, but this Appbuilder only knows version 4. ...
```

and stays up without a database: every data route answers 503, `GET /api/v1/status` reports `setup.incompatible: true`,
the browser shows "This database needs a newer Appbuilder", and the setup screen cannot be used to point it elsewhere.
It does not retry. Start the newer version again, or restore the pre-upgrade backup into the database before starting
the old code.

## Roll back

If the new version misbehaves:

1. Stop the server.
2. In the source folder, return to the previous commit you noted before upgrading (`git checkout <commit>`; note it
   with `git rev-parse HEAD` before you pull), then `npm ci` and `npm run build`.
3. If the new version had run (and might have changed the database), drop the database, recreate it and restore your
   pre-upgrade dump, and restore the workspace folder copy as well ([Backup and restore](backup-and-restore.md)).
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
