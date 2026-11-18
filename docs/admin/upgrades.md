# Upgrades

Appbuilder is installed from its source folder, so an upgrade means getting newer source, rebuilding and restarting.
There is no installer, no automatic update and no release channel yet. There is also no change log
(`CHANGELOG`) in the repository, so read the commit history of what you pull before you apply it.

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

On every start the server runs its schema step, which does `CREATE TABLE IF NOT EXISTS` for every `ab_` system table
and records `schemaVersion` = 1 in `ab_meta`. In this version:

- Nothing is altered or converted in existing tables; the only schema version so far is 1, and the code has a placeholder
  for future upgrade steps ("future upgrades go here"). A future release that needs to change a table will ship such a
  step, and you will then read about it in that release's notes.
- Because the step only creates what is missing, starting a *newer* version against your database is safe today.
- **Starting an older version against a database that a newer version has changed is not blocked.** There is no check
  that the database is newer than the code. When a release introduces schema changes, never run the old code on the
  changed database; restore the pre-upgrade backup instead.
- The user tables (`t_...`) are yours and are not touched by upgrades.
- The schema step needs the database user to have `CREATE` (and, for future steps, probably `ALTER`) rights; a
  restricted user as described in [Installation](installation.md#prepare-the-database) works.

## Roll back

If the new version misbehaves:

1. Stop the server.
2. In the source folder, return to the previous commit you noted before upgrading (`git checkout <commit>`; note it
   with `git rev-parse HEAD` before you pull), then `npm ci` and `npm run build`.
3. If the new version had run (and might have changed the database), drop the database, recreate it and restore your
   pre-upgrade dump, and restore the workspace folder copy as well ([Backup and restore](backup-and-restore.md)).
   While the schema version is still 1 and the release notes say nothing about schema changes, rolling back the code
   alone has worked in principle, but we have not tested rolling back across versions, so keep the dump anyway.
4. Start the server.

## Migrating an older file-based workspace

Early versions (phase 2) kept data in files: `workspace.yaml`, `tables/*.schema.yaml` and `apps/*.app.yaml` in the
workspace folder, and CSV data. The current version stores everything in MySQL. A conversion exists, but it runs only
**once, at the moment the first administrator is created on the setup screen**, and only if those files are found in
the workspace folder.

What it does (tested with a sample old workspace):

- Tables become tables on the built-in **Data files** connection (so they stay on this PC and are not in MySQL;
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
- Downgrade protection.
- Re-running the legacy conversion on a live system.
- Zero-downtime upgrades: the server must be restarted, which ends nothing permanently (sessions live in the database)
  but briefly interrupts users. In-memory login throttle counters are reset by a restart.
