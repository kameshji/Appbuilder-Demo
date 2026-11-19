# Backup and restore (design)

P0 package J, decision D21. Administrator view: `docs/admin/backup-and-restore.md`, `docs/admin/disaster-recovery.md`.

| Module | What it does |
| --- | --- |
| `server/core/backup/archive.ts` | The container: tar writer/reader (ustar + pax), the chunked AES-256-GCM container, random-access readers, checksums |
| `server/core/backup/pgtools.ts` | Finding `pg_dump` / `pg_restore` and their versions; running them (password in `PGPASSWORD`, never on the command line) |
| `server/core/backup/dbdump.ts` | The catalogue reader (`schema.json`), the built-in exporter (`COPY ... TO STDOUT`), DDL for any target schema, pg_restore SQL handling (statement splitter, schema rename, the data-section parser), COPY text parsing |
| `server/core/backup/engine.ts` | `createArchive`, `openArchive`, `verifyArchive`, `restoreSchema`, `tableData`, `extractEnvironmentFiles`: no HTTP, no catalogue |
| `server/core/backup/retention.ts` | `decideRetention`: grandfather-father-son as a pure function (table-driven tests) |
| `server/core/backup/service.ts` | The service: settings, catalogue, jobs and schedules, snapshots (`BackupService`), restores, verification, restore test, health, notifications, upload/download, the pre-migration backup |
| `server/core/backup/routes.ts` | HTTP API (`docs/dev/data-api.md` "Backups"); shapes in `src/platform/backup.ts` |
| `server/core/backup/cli.ts` | `node server/main.ts restore <archive>`: install restore |
| `server/core/backup/ddl.ts` | Schema version 7 (package J's part): `ab.backups`, `ab.backup_ops` |
| `src/portal/AdminBackups.tsx`, `backupApi.ts`, `RestoreNotice.tsx` | Admin console > Backups, the health line, the "being restored" strip |
| `scripts/drill/restore-drill.mjs` | The Phase-0 exit drill |
| `scripts/docs-shots/backups.mjs` | Headless walkthrough of the page (and its screenshots) |

## Archive format (version 1)

One file, `appbuilder-<install|environment id>-<YYYYMMDD-HHMMSS>Z-<id6>.abbak`. Plain: a POSIX tar (512-byte ustar headers;
a pax `x` record before a member whose name is longer than 100 bytes or not ASCII, or whose size exceeds 8 GB). Members, in
this order:

| Member | Content |
| --- | --- |
| `appbuilder-backup.json` | always first: `{ format: "appbuilder-backup", formatVersion: 1, id, kind, createdOn }` (identifies the file before the manifest is read; a higher `formatVersion` is refused) |
| `db/dump.pgc` | pg_dump method: ONE custom-format dump (`-Fc -Z6 --no-owner --no-acl --snapshot=<exported>`, `--schema` per schema, `--exclude-table-data` for `ab.sessions`, `ab.auth_tokens`, `ab.backups`, `ab.backup_ops`) |
| `db/<schema>/<table>.copy.gz` | built-in method: the table's rows, `COPY (cols) TO STDOUT` text format, gzip |
| `db/<schema>/schema.json` | always (both methods): the `Catalog` of the schema (tables: columns with `format_type`, defaults, identity options and current values, constraints, non-constraint index definitions; standalone sequences; views; counts of functions/triggers/types not copied by the built-in exporter); schema references written as `{{schema}}`; `rows` per table |
| `files/<env>/attachments/<key[0..1]>/<key>` | attachment files, as they are on disk |
| `files/<env>/files/...` | data files (copied to a work file first: they can be rewritten at any time) |
| `key/secret-key` | only with "include the encryption key": the 64 hex characters |
| `manifest.json` | always last: `Manifest` (`engine.ts`): id, kind, trigger, note, created/finished, creator, app version and schema version, server version, method (+ pg_dump version), snapshot info, `includesKey`, `schemas[]` (tables with exact row counts, `noData`), `environments[]` (id, name, type, schema version, attachment and data file counts and bytes, missing attachment files, Appbuilder tables with source, rows and columns), `files[]` (every other member: name, size, sha256), `warnings[]` |

**Encrypted** (passphrase): the whole tar inside a chunked AEAD container. Header (64 bytes): `ABBAKENC`, version 1,
scrypt `log2 N` (15), `r` (8), `p` (1), chunk size (u32 BE, 65,536), salt (16), nonce prefix (7), zero padding. Then chunks:
AES-256-GCM of each 64 KB of the tar plus its 16-byte tag; the last chunk may be shorter (also empty). Key =
scrypt(passphrase NFC, salt, 32). Nonce of chunk *i* = prefix ‖ *i* (u32 BE) ‖ last-flag byte; every chunk's additional data
is the 64 header bytes. So: a wrong passphrase fails on the first chunk; a changed byte, reordered chunks, a truncated
file (the last-flag) or a changed header fail authentication; any byte range can be read without decrypting the rest
(listing members, browsing one table), in bounded memory.

**Integrity of plain archives**: every member's sha256 is in the manifest; the catalogue row keeps the file's sha256 and the
manifest's sha256 from creation time (`verifyArchive(expectedManifestSha256)` detects a rewritten manifest). Members not in
the manifest are an error. Paths are checked on extraction (no `..`, absolute paths, backslashes or drive letters).

## Consistency

`createArchive` opens one connection, `BEGIN ISOLATION LEVEL REPEATABLE READ, READ ONLY`, exports the snapshot
(`pg_export_snapshot()`), reads the catalogue and exact `count(*)` of every table, and lists the attachment records, all in
that snapshot. pg_dump then runs with `--snapshot=<id>` (the transaction stays open until it exits), so dump, counts and
catalogue are the same instant across every schema of the backup. The built-in exporter runs its `COPY`s inside the same
transaction. The test "a consistent snapshot while a writer keeps writing" runs a writer that inserts one row into each of
two tables per transaction during the backup (both methods): the restored tables always have equal counts, equal to the
manifest's, and fewer than were written by the end.

Files are copied after the snapshot transaction ends. Attachments are content-addressed and never rewritten; one deleted
between the snapshot and the copy is reported (`attachments.missing`, a warning). Data files are flushed (files connector)
and copied before being added. Sizes are taken when a member starts; a source that grows or shrinks is an error.

Recycle bins ([recycle-bin.md](recycle-bin.md)) are part of the data: deleted rows stay in their tables until purged and
`ab_delete_batches` / `ab_delete_effects` are environment tables, so a backup contains them and an environment restore
brings the bins back. A single-table restore brings the table's deleted rows without their batches; the purge job removes
such rows once they are older than the table's retention.

## Verification

`verifyArchive`: every manifest member is present with its size and sha256, no unlisted member, then rows are counted again
from the data (built-in: gunzip and count lines; pg_dump: `pg_restore --data-only -f -` streamed from the archive through
`RestoreDataParser`, counting each COPY block) and compared with the manifest. Without `pg_restore` the row count of a
pg_dump archive is noted as not re-checked (checksums still are). Runs after every backup (state `verifying` → `ok`), before
every environment restore and install restore, for uploads, and in the restore test.

## Restoring a schema under another name

`restoreSchema(client, archive, source, target)` runs on the caller's transaction. Built-in archives: DDL generated from
`schema.json` for `target` (tables with identity/generated/defaults/NOT NULL, then COPY FROM STDIN per table, then identity
values, constraints, indexes, foreign keys, views). pg_dump archives: the dump is extracted to a work file (pg_restore needs
to seek), `pg_restore --section=pre-data|data|post-data --schema <source> --no-owner --no-acl -f -` produces SQL; `SET`,
`set_config`, `CREATE/ALTER SCHEMA`, owner changes and psql meta-commands (`\restrict` of newer versions) are dropped; schema
qualifications `source.` / `"source".` (and regclass literals) are rewritten to `target`; the data section's `COPY ... FROM
stdin;` blocks are piped line by line into `COPY "target"."table" (...) FROM STDIN` (pg-copy-streams). Every table's stored
row count is checked against the manifest. Because the target name is free, the same code restores in place (after `DROP
SCHEMA`), as a new environment, into scratch schemas (restore test, table restores) and on a fresh machine.

## Restore modes

- **In place**: check the archive; safety backup (`pre-restore`; a failure stops it unless `proceedWithoutBackup`); registry
  state `restoring` (requests 503 "being restored", the worker skips it, `emitEnv(state, { restoring: true })`); files into
  `env/<id>.restore-<op>`; ONE transaction: `DROP SCHEMA env_x CASCADE`, `restoreSchema`, fixups (undispatched outbox rows
  marked dispatched, queued/running/failed jobs cancelled, roles of users that no longer exist removed), `schema_version`
  set to the backup's and `migrateEnvironmentSchema` run on the same transaction (older backups are upgraded), access rows
  for users with roles added and `is_env_admin` recomputed, the op's phase set to `swap-files`; COMMIT; then the folder
  swap (`env/<id>` → `.pre-<op>`, staging → `env/<id>`, old removed); caches dropped, built-in connections rewritten.
  Interrupted before COMMIT: nothing changed (the transaction rolled back); at the next start the staging folder is
  removed and the environment is `ready`. Interrupted after COMMIT: the next start finishes the swap (phase `swap-files`).
- **As new**: registry row `creating`, files into `env/<new>/`, one transaction (restore, fixups, connection secrets
  cleared unless kept, roles dropped unless kept, migration), then the restorer gets the Administrator role. A failure
  drops what was made and marks it `failed` like a failed creation.
- **Tables**: a plan (token = hash of the plan) per table; apply: one transaction, the backup's rows into a scratch schema
  (`preDataSql` with the backup's own column types), then `INSERT ... SELECT` of the common columns cast to the target's
  types (replace: after `DELETE`; new: into a table made with `createTableSql` like any platform table). Attachment records
  come along (new ids for new tables, cells rewritten through a temporary map), missing files are extracted.

## Jobs, schedules, locking

Job types `backup.run` (concurrency 1, one attempt, 24 h timeout, heartbeat every 10 s), `backup.restore-test`,
`backup.health` (hourly: retention, the stale-backup notification at most once a day). Schedules live in Default's
`ab_schedules` as built-ins with fixed ids, synced from the settings (`ab.settings` key `backup.config`) at start and on
every change; misfire `run_once`. All engine work runs in one in-process queue (`exclusive`) that also holds
`pg_advisory_lock(hashtext('appbuilder.backup'))` on its own connection; snapshots taken inside a restore do not re-enter it.
A manual backup's passphrase is kept in memory only (`pendingPass`): after a restart that backup fails with that reason.

## Threat model

| Threat | Mitigation |
| --- | --- |
| A stolen archive | Optional passphrase (AES-256-GCM, scrypt N=2^15); the key file only on request with a warning; sessions, reset tokens and the backup catalogue are never in a backup; password hashes are |
| A tampered archive | Checksums in the manifest and the manifest's checksum in the catalogue (plain); per-chunk authentication (encrypted); verification before every restore; unsafe paths refused |
| Restoring over live data by mistake | As-new is the default; in place needs the typed name, takes a safety backup, is one transaction; table replace needs the plan's token and a tick |
| Exfiltration through download | Install administrators only, recent sign-in (`requireRecentAuth`, package I) or a one-minute single-use ticket issued after it, audited |
| Writing archives where the web server serves them | The folder must be absolute, not inside the web folder or an environment folder, writable (checked) |
| The saved passphrase | Sealed with the SecretBox; stated in the UI |
| A newer backup on an older server | Refused (schema version, archive format version) |
| Losing data in a server upgrade | Install backup before the first migration step; the migration does not run when it fails |
| Disk filling up | Retention; upload size limit; temporary files removed after failures and at start |

## Tests

`backup.test.ts` (unit: tar, encryption, COPY parsing, SQL splitting/renaming, retention table), `backup.integration.test.ts`
(17 end-to-end cases, both methods), `backup.large.integration.test.ts` (opt-in `APPBUILDER_TEST_LARGE=1`: 1M rows + 500 MB),
the drill, and the browser walkthrough.
